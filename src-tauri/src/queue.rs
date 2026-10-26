//! Shared job queue (SPEC 4.2). Modules submit jobs made of steps; the scheduler runs them
//! with a concurrency limit, persists to hermes-data/queue.json and survives restarts.
//! Events: "queue" = full snapshot on any state change, "job" = {id, progress, detail} ticks.
use crate::{binaries, data_dir, eagle, now_ms, read_json, setting, write_json};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{LazyLock, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::Notify,
};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Queued,
    Running,
    Paused,
    WaitingEagle,
    Done,
    Failed,
}

/// How a step's console output is read.
#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Parser {
    /// yt-dlp with `--newline --progress-template "download:[hermes] %(progress.downloaded_bytes)s
    /// %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s"`
    /// and `--print "after_move:[file] %(filepath)s"`.
    YtDlp,
    /// ffmpeg with `-progress pipe:1 -nostats`; needs the step's `duration` (seconds).
    Ffmpeg,
    /// Any tool: last line becomes the detail; `[file] <path>` lines are outputs.
    Plain,
    /// gallery-dl: each printed absolute path is a downloaded file, "# <path>" a skipped one.
    /// The step's `duration` holds the expected file count for the progress bar.
    GalleryDl,
    /// Tools printing "42.50%" / "42,50%" lines (Real-ESRGAN).
    Percent,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Step {
    /// Run a bundled tool (file name in hermes-data/bin). `outputs` are files it is known to create.
    /// `args`/`outputs` may use `{last}` / `{last_noext}` (previous output file). `replace`: on
    /// success this step's outputs supersede the earlier ones, which are deleted from disk.
    #[serde(rename_all = "camelCase")]
    Run {
        label: String,
        bin: String,
        args: Vec<String>,
        parser: Parser,
        #[serde(default)]
        outputs: Vec<String>,
        #[serde(default)]
        duration: f64,
        #[serde(default)]
        replace: bool,
    },
    /// Import every output so far into Eagle, then delete it from disk (unless `keep`: modules that
    /// show a before/after preview keep their result in hermes-data/results).
    Eagle {
        #[serde(default)]
        keep: bool,
    },
    /// Delete files/folders (temp frames of a video upscale). Placeholders allowed.
    Delete { paths: Vec<String> },
    /// Background removal with an ONNX model (src-tauri/src/rembg.rs).
    #[serde(rename_all = "camelCase")]
    Rembg {
        model: String,
        input: String,
        output: String,
        #[serde(default)]
        background: String, // "" = transparent, else "#rrggbb"
        #[serde(default)]
        crop: bool,
    },
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    id: String,
    module: String,
    title: String,
    #[serde(default)]
    pill: String,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    group: bool,
    #[serde(default)]
    steps: Vec<Step>,
    #[serde(default)]
    step: usize,
    state: State,
    #[serde(default)]
    progress: f64,
    #[serde(default)]
    detail: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    outputs: Vec<String>,
    #[serde(default)]
    eagle: eagle::Meta,
    #[serde(default)]
    in_eagle: bool,
    /// Original input file, for before/after previews (Background Removal, Upscale).
    #[serde(default)]
    source: String,
}

/// What a module submits. A job with `children` becomes an expandable group (it never runs itself).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    module: String,
    title: String,
    #[serde(default)]
    pill: String,
    #[serde(default)]
    steps: Vec<Step>,
    #[serde(default)]
    eagle: eagle::Meta,
    #[serde(default)]
    children: Vec<NewJob>,
    /// Files that already exist (e.g. a kept compare result that only needs the Eagle step).
    #[serde(default)]
    outputs: Vec<String>,
    #[serde(default)]
    source: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    jobs: Vec<Job>,
    /// Absolute wall-clock ms; nothing starts before it (rate-limit cooldown, survives restarts).
    #[serde(default)]
    paused_until: i64,
    #[serde(default)]
    backoff_min: i64,
    #[serde(default)]
    paused_all: bool,
}

static Q: LazyLock<Mutex<Queue>> = LazyLock::new(|| {
    let mut q: Queue = read_json(&path()).unwrap_or_default();
    for j in q.jobs.iter_mut().filter(|j| j.state == State::Running) {
        j.state = State::Queued; // interrupted by app exit; tools resume partial files
    }
    Mutex::new(q)
});
static KICK: Notify = Notify::const_new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static PIDS: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(Default::default);
/// Earliest start per group, to space playlist items 2-5 s apart.
static NEXT_IN_GROUP: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);

fn path() -> PathBuf {
    data_dir().join("queue.json")
}

fn lock() -> std::sync::MutexGuard<'static, Queue> {
    Q.lock().unwrap_or_else(|e| e.into_inner())
}

/// Mutates the queue, then persists and broadcasts it.
fn with<R>(f: impl FnOnce(&mut Queue) -> R) -> R {
    let mut q = lock();
    let r = f(&mut q);
    write_json(&path(), &*q).ok();
    if let Some(app) = APP.get() {
        app.emit("queue", &*q).ok();
    }
    drop(q);
    KICK.notify_one();
    r
}

fn job_mut<'a>(q: &'a mut Queue, id: &str) -> Option<&'a mut Job> {
    q.jobs.iter_mut().find(|j| j.id == id)
}

fn kill(id: &str) {
    if let Some(pid) = PIDS.lock().unwrap().remove(id) {
        // /T: yt-dlp spawns ffmpeg, kill the whole tree
        let mut c = std::process::Command::new("taskkill");
        std::os::windows::process::CommandExt::creation_flags(&mut c, binaries::NO_WINDOW);
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).status().ok();
    }
}

/// Kills every running tool (app exit). States stay Running and become Queued on next launch.
pub fn shutdown() {
    let ids: Vec<String> = PIDS.lock().unwrap().keys().cloned().collect();
    ids.iter().for_each(|id| kill(id));
}

// ---------- scheduler ----------

pub fn start(app: AppHandle) {
    APP.set(app).ok();
    tauri::async_runtime::spawn(async {
        let mut last_eagle_check = 0;
        loop {
            tokio::select! {
                _ = KICK.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            let waiting = lock().jobs.iter().any(|j| j.state == State::WaitingEagle);
            if waiting && now_ms() - last_eagle_check > 10_000 {
                last_eagle_check = now_ms();
                if eagle::online().await {
                    with(|q| q.jobs.iter_mut().filter(|j| j.state == State::WaitingEagle).for_each(|j| j.state = State::Queued));
                }
            }
            for id in pick() {
                tauri::async_runtime::spawn(run(id));
            }
        }
    });
}

/// Marks the jobs that may start now as Running and returns their ids.
/// Only writes when something starts: `with` wakes the scheduler, so writing on every tick would spin.
fn pick() -> Vec<String> {
    let now = now_ms();
    let max = setting("maxConcurrent").as_i64().unwrap_or(3).clamp(1, 5) as usize;
    let mut next = NEXT_IN_GROUP.lock().unwrap();
    let ids: Vec<(String, Option<String>)> = {
        let q = lock();
        if q.paused_all || now < q.paused_until {
            return vec![];
        }
        let mut free = max.saturating_sub(q.jobs.iter().filter(|j| j.state == State::Running).count());
        let mut groups = std::collections::HashSet::new();
        let mut ids = vec![];
        for j in q.jobs.iter().filter(|j| j.state == State::Queued && !j.group) {
            if free == 0 {
                break;
            }
            if let Some(p) = &j.parent {
                // one start per group per spacing window
                if next.get(p).is_some_and(|t| now < *t) || !groups.insert(p) {
                    continue;
                }
            }
            ids.push((j.id.clone(), j.parent.clone()));
            free -= 1;
        }
        ids
    };
    if ids.is_empty() {
        return vec![];
    }
    with(|q| {
        for (id, parent) in &ids {
            if let Some(j) = job_mut(q, id) {
                j.state = State::Running;
                j.error.clear();
            }
            if let Some(p) = parent {
                next.insert(p.clone(), now + 2000 + now % 3000);
            }
        }
    });
    ids.into_iter().map(|(id, _)| id).collect()
}

enum Stop {
    Failed(String),
    RateLimited,
    EagleOffline,
    Cancelled, // user paused or removed it
}

async fn run(id: String) {
    loop {
        let Some(job) = lock().jobs.iter().find(|j| j.id == id).cloned() else { return };
        if job.state != State::Running {
            return;
        }
        let Some(step) = job.steps.get(job.step).cloned() else {
            with(|q| {
                if let Some(j) = job_mut(q, &id) {
                    j.state = State::Done;
                    j.progress = 1.0;
                    j.detail.clear();
                }
                q.backoff_min = 0;
            });
            return;
        };
        let mut replace_outputs = false;
        let result = match step {
            Step::Run { label, bin, args, parser, outputs, duration, replace } => {
                replace_outputs = replace;
                // one GPU upscale at a time (rembg serialises on its own session lock)
                static GPU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
                let _gpu = if bin.starts_with("realesrgan") { Some(GPU.lock().await) } else { None };
                let last = job.outputs.last().cloned().unwrap_or_default();
                let fill = |s: &String| fill_placeholders(s, &last);
                let args: Vec<String> = args.iter().map(fill).collect();
                let outputs: Vec<String> = outputs.iter().map(fill).collect();
                run_tool(&id, &label, &bin, &args, parser, duration).await.map(|mut found| {
                    found.extend(outputs);
                    found
                })
            }
            Step::Eagle { keep } => eagle_step(&job, keep).await.map(|_| vec![]),
            Step::Delete { paths } => {
                let last = job.outputs.last().cloned().unwrap_or_default();
                for p in paths.iter().map(|p| PathBuf::from(fill_placeholders(p, &last))) {
                    if p.is_dir() { std::fs::remove_dir_all(&p).ok(); } else { std::fs::remove_file(&p).ok(); }
                }
                Ok(vec![])
            }
            Step::Rembg { model, input, output, background, crop } => {
                tick(&id, 0.0, "Removing background".into());
                crate::rembg::remove(&model, &input, &output, &background, crop).await.map(|_| vec![output]).map_err(Stop::Failed)
            }
        };
        let ok = with(|q| {
            let rate_limited = matches!(result, Err(Stop::RateLimited));
            let Some(j) = job_mut(q, &id) else { return false };
            match result {
                Ok(found) => {
                    if replace_outputs {
                        // e.g. converted mp4 supersedes the downloaded mkv
                        j.outputs.iter().filter(|o| !found.contains(o)).for_each(|o| drop(std::fs::remove_file(o)));
                        j.outputs.clear();
                    }
                    j.outputs.extend(found);
                    j.in_eagle |= matches!(j.steps[j.step], Step::Eagle { .. });
                    j.step += 1;
                    j.progress = 0.0;
                    return true;
                }
                Err(Stop::Failed(e)) if j.state == State::Running => {
                    j.state = State::Failed;
                    j.error = e;
                }
                Err(Stop::RateLimited) => j.state = State::Queued,
                Err(Stop::EagleOffline) => j.state = State::WaitingEagle,
                _ => {}
            }
            j.detail.clear();
            if rate_limited {
                q.backoff_min = if q.backoff_min == 0 { 5 } else { (q.backoff_min * 2).min(60) };
                q.paused_until = now_ms() + q.backoff_min * 60_000;
            }
            false
        });
        if !ok {
            return;
        }
    }
}

/// `{last}` = previous step's last output file, `{last_noext}` = same without extension.
fn fill_placeholders(s: &str, last: &str) -> String {
    let noext = std::path::Path::new(last).with_extension("");
    s.replace("{last_noext}", &noext.to_string_lossy()).replace("{last}", last)
}

fn tick(id: &str, progress: f64, detail: String) {
    let mut q = lock();
    if let Some(j) = job_mut(&mut q, id) {
        j.progress = progress;
        j.detail = detail.clone();
    }
    drop(q);
    if let Some(app) = APP.get() {
        app.emit("job", serde_json::json!({ "id": id, "progress": progress, "detail": detail })).ok();
    }
}

fn human_bytes(b: f64) -> String {
    if b >= 1_073_741_824.0 { format!("{:.1} GB", b / 1_073_741_824.0) } else { format!("{:.1} MB", b / 1_048_576.0) }
}

fn clock(secs: f64) -> String {
    let s = secs as i64;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

/// Runs one tool step; Ok(output files it reported).
async fn run_tool(id: &str, label: &str, bin: &str, args: &[String], parser: Parser, duration: f64) -> Result<Vec<String>, Stop> {
    let mut child = binaries::command(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Stop::Failed(format!("Could not start {bin}: {e}")))?;
    if let Some(pid) = child.id() {
        PIDS.lock().unwrap().insert(id.into(), pid);
    }
    // split on bytes + lossy decode: one non-UTF-8 line must not end the read loop
    let mut out = BufReader::new(child.stdout.take().unwrap()).split(b'\n');
    let mut err = BufReader::new(child.stderr.take().unwrap()).split(b'\n');
    let (mut out_done, mut err_done) = (false, false);
    let mut files = vec![];
    let mut error_line = String::new(); // last "ERROR: ..." line
    let mut last_line = String::new(); // fallback for tools without an ERROR prefix (ffmpeg)
    let mut rate_limited = false;
    let mut last_tick = 0;
    let mut count = 0u32; // GalleryDl files seen
    tick(id, 0.0, label.into());

    while !(out_done && err_done) {
        let line = tokio::select! {
            l = out.next_segment(), if !out_done => l.ok().flatten().or_else(|| { out_done = true; None }),
            l = err.next_segment(), if !err_done => l.ok().flatten().or_else(|| { err_done = true; None }),
        };
        let Some(line) = line else { continue };
        let line = String::from_utf8_lossy(&line);
        let line = line.trim();
        if let Some(f) = line.strip_prefix("[file] ") {
            files.push(f.to_string());
            continue;
        }
        let lower = line.to_lowercase();
        if ["http error 429", "429 too many requests", "sign in to confirm you", "rate-limit", "rate limit"].iter().any(|s| lower.contains(s)) {
            rate_limited = true;
        }
        if let Some(e) = line.strip_prefix("ERROR: ") {
            error_line = e.to_string();
        } else if let Some((_, e)) = line.split_once("][error] ") {
            error_line = e.to_string(); // gallery-dl: "[download][error] Failed to download ..."
        } else if !line.is_empty() && !line.starts_with("[hermes]") && !line.contains('=') {
            last_line = line.to_string();
        }
        let update = match parser {
            Parser::YtDlp => line.strip_prefix("[hermes] ").and_then(|p| {
                let v: Vec<f64> = p.split(' ').map(|x| x.parse().unwrap_or(f64::NAN)).collect();
                let (done, total, est, speed, eta) = (v[0], v[1], v[2], v[3], v[4]);
                let total = if total.is_nan() { est } else { total };
                let pct = if total > 0.0 { done / total } else { 0.0 };
                let mut d = format!("{label} {:.0}%", pct * 100.0);
                if speed.is_finite() { d += &format!(" · {}/s", human_bytes(speed)) }
                if eta.is_finite() { d += &format!(" · {}", clock(eta)) }
                Some((pct, d))
            }),
            Parser::Ffmpeg => line.strip_prefix("out_time_us=").and_then(|us| {
                let pct = (us.parse::<f64>().ok()? / 1e6 / duration.max(0.001)).clamp(0.0, 1.0);
                Some((pct, format!("{label} {:.0}%", pct * 100.0)))
            }),
            Parser::Plain => (!line.is_empty()).then(|| (0.0, format!("{label} · {line}"))),
            Parser::GalleryDl => {
                let skipped = line.strip_prefix("# ");
                let path = skipped.unwrap_or(line);
                let b = path.as_bytes();
                let is_path = b.len() > 3 && b[1] == b':' && b[2] == b'\\';
                // A skipped file still on disk came from an earlier interrupted run and still needs
                // its Eagle import; skipped files already imported were deleted, so they don't count.
                if is_path && (skipped.is_none() || std::path::Path::new(path).exists()) {
                    files.push(path.to_string());
                }
                is_path.then(|| {
                    count += 1;
                    let total = duration.max(count as f64);
                    (count as f64 / total, format!("{label} {count} / {total:.0}"))
                })
            }
            Parser::Percent => line
                .strip_suffix('%')
                .and_then(|n| n.trim().replace(',', ".").parse::<f64>().ok())
                .map(|p| (p / 100.0, format!("{label} {p:.0}%"))),
        };
        if let Some((pct, detail)) = update {
            if now_ms() - last_tick > 200 {
                last_tick = now_ms();
                tick(id, pct, detail);
            }
        }
    }
    let status = child.wait().await;
    PIDS.lock().unwrap().remove(id);
    let still_running = lock().jobs.iter().any(|j| j.id == id && j.state == State::Running);
    if !still_running {
        return Err(Stop::Cancelled);
    }
    if rate_limited {
        return Err(Stop::RateLimited);
    }
    match status {
        Ok(s) if s.success() => Ok(files),
        Ok(s) => Err(Stop::Failed(
            [error_line, last_line].into_iter().find(|l| !l.is_empty()).unwrap_or(format!("{bin} exited with {s}")),
        )),
        Err(e) => Err(Stop::Failed(e.to_string())),
    }
}

async fn eagle_step(job: &Job, keep: bool) -> Result<(), Stop> {
    if !eagle::online().await {
        return Err(Stop::EagleOffline);
    }
    let files: Vec<PathBuf> = job.outputs.iter().map(PathBuf::from).filter(|p| p.exists()).collect();
    if files.is_empty() {
        return Err(Stop::Failed("No output file to send to Eagle".into()));
    }
    for (i, f) in files.iter().enumerate() {
        tick(&job.id, i as f64 / files.len() as f64, "Importing to Eagle".into());
        eagle::add(f, &job.eagle).await.map_err(Stop::Failed)?;
        if !keep {
            std::fs::remove_file(f).ok();
        }
    }
    Ok(())
}

// ---------- commands ----------

#[tauri::command]
pub fn queue_get() -> Queue {
    lock().clone()
}

#[tauri::command]
pub fn queue_add(jobs: Vec<NewJob>) -> Vec<String> {
    fn make(n: NewJob, parent: Option<String>, out: &mut Vec<Job>) -> String {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = format!("{}-{}", now_ms(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let group = !n.children.is_empty();
        out.push(Job {
            id: id.clone(),
            module: n.module,
            title: n.title,
            pill: n.pill,
            parent,
            group,
            steps: n.steps,
            step: 0,
            state: State::Queued,
            progress: 0.0,
            detail: String::new(),
            error: String::new(),
            outputs: n.outputs,
            eagle: n.eagle,
            in_eagle: false,
            source: n.source,
        });
        for c in n.children {
            make(c, Some(id.clone()), out);
        }
        id
    }
    let mut new = vec![];
    let ids = jobs.into_iter().map(|n| make(n, None, &mut new)).collect();
    with(|q| q.jobs.extend(new));
    ids
}

/// pause | resume | retry | remove | keep ("Keep in folder": skip the Eagle import).
/// On a group it applies to all its children.
#[tauri::command]
pub fn queue_action(id: String, action: String) -> Result<(), String> {
    let ids: Vec<String> = {
        let q = lock();
        q.jobs.iter().filter(|j| j.id == id || j.parent.as_deref() == Some(&id)).map(|j| j.id.clone()).collect()
    };
    with(|q| {
        for j in q.jobs.iter_mut().filter(|j| ids.contains(&j.id)) {
            use State::*;
            j.state = match (action.as_str(), j.state) {
                ("pause", Queued | Running | WaitingEagle) => Paused,
                ("resume", Paused) | ("retry", Failed | WaitingEagle) => Queued,
                ("keep", WaitingEagle) => Done,
                _ => j.state,
            };
            if j.state != Running {
                j.detail.clear();
            }
        }
        if action == "remove" {
            q.jobs.retain(|j| !ids.contains(&j.id));
        }
    });
    if matches!(action.as_str(), "pause" | "remove") {
        ids.iter().for_each(|i| kill(i));
    }
    Ok(())
}

#[tauri::command]
pub fn queue_pause_all(paused: bool) {
    let running: Vec<String> = with(|q| {
        q.paused_all = paused;
        let mut running = vec![];
        for j in q.jobs.iter_mut() {
            match (paused, j.state) {
                (true, State::Running) => {
                    running.push(j.id.clone());
                    j.state = State::Paused;
                }
                (true, State::Queued) => j.state = State::Paused,
                (false, State::Paused) => j.state = State::Queued,
                _ => {}
            }
        }
        running
    });
    running.iter().for_each(|i| kill(i));
}

#[tauri::command]
pub fn queue_clear_finished() {
    with(|q| {
        q.jobs.retain(|j| j.state != State::Done || j.group);
        let parents: Vec<String> = q.jobs.iter().filter_map(|j| j.parent.clone()).collect();
        q.jobs.retain(|j| !j.group || parents.contains(&j.id));
    });
}

/// Ends a rate-limit cooldown early.
#[tauri::command]
pub fn queue_resume_now() {
    with(|q| q.paused_until = 0);
}
