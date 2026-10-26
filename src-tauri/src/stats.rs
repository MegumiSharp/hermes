//! Live system stats for the AI tools (CPU, RAM, NVIDIA GPU/VRAM). Shown when settings.showStats.
use serde_json::{json, Value};
use std::sync::{LazyLock, Mutex};
use sysinfo::System;

static SYS: LazyLock<Mutex<System>> = LazyLock::new(|| {
    let mut s = System::new();
    s.refresh_cpu_usage(); // CPU % needs two samples: take the first now so the first reading isn't bogus
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    Mutex::new(s)
});

/// `{cpu %, ramUsed, ramTotal (bytes), gpu: {name, util %, vramUsed, vramTotal (MB), temp} | null}`
#[tauri::command]
pub async fn system_stats() -> Value {
    let (cpu, used, total) = {
        let mut s = SYS.lock().unwrap();
        s.refresh_cpu_usage(); // usage is measured between two refreshes: the UI polls every 2 s
        s.refresh_memory();
        (s.global_cpu_usage(), s.used_memory(), s.total_memory())
    };
    json!({ "cpu": cpu, "ramUsed": used, "ramTotal": total, "gpu": gpu().await })
}

/// NVIDIA only: nvidia-smi ships with the driver. Other GPUs report null.
async fn gpu() -> Value {
    let out = tokio::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"])
        .creation_flags(crate::binaries::NO_WINDOW)
        .output()
        .await;
    let Ok(out) = out else { return Value::Null };
    let text = String::from_utf8_lossy(&out.stdout);
    let f: Vec<&str> = text.lines().next().unwrap_or_default().split(',').map(str::trim).collect();
    if f.len() < 5 {
        return Value::Null;
    }
    let n = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
    json!({ "name": f[0], "util": n(1), "vramUsed": n(2), "vramTotal": n(3), "temp": n(4) })
}
