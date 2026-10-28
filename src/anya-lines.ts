// What Anya says. Playful, a little tsundere, always sweet; English like the rest of the UI.
// Quotes are cited (short line + source) and always followed by a comment of her own.

export type Quote = { q: string; src: string; then: string[] };

export const HELLO = [
  "Oh. You're back. Not that I was waiting or anything.",
  "Hermes is warmed up. I did that. You're welcome.",
  "Ready when you are. Well, I was ready ages ago.",
  "Took you long enough. ...Hi.",
  "Welcome back! I kept everything tidy. Mostly.",
  "Morning, evening, whatever. Let's make something cool.",
  "You again? Good. I mean. Fine.",
  "I dusted the queue while you were gone. It was very dusty.",
];

export const TOOL: Record<string, string[]> = {
  video: [
    "Paste a link and I'll fetch it. Just don't make me download four hours of unboxings again.",
    "Tip: tick 'Convert to MP4 for Premiere' and your editor won't complain. Unlike me.",
    "Playlists work too. I'll queue every single video. Every. Single. One.",
    "Audio only gives you a proper MP3 with the cover. Square, like it should be.",
    "Pick a resolution if you don't need 4K. Your disk will thank you. I won't, but your disk will.",
    "WAV 48 kHz is the one for editing. I labelled it 'Montaggio' just for you.",
    "If YouTube asks you to sign in, set the cookies. I can't charm my way past that. Yet.",
  ],
  spotify: [
    "I check every source, you know. No fan uploads sneak past me.",
    "Opus keeps YouTube Music's own audio. No re-encode. I'm very thorough, hmph.",
    "Paste a playlist. I'll find the official tracks, obviously.",
    "Red chips mean I didn't trust the match. Green means I approve. Be honoured.",
    "A whole album? Sure. I'll even keep the track numbers in order.",
    "Covers, remixes and sped-up versions get kicked out. I have standards.",
  ],
  gallery: [
    "A whole gallery? Fine. I'll carry it all. Tch.",
    "Use the filters before you grab everything. I'm strong, not a hoarder.",
    "Untick the ones you don't want. I'm not reading your mind. ...Not yet.",
    "Skip already-downloaded files stays on, so I never fetch the same picture twice.",
    "Minimum size filters keep the tiny thumbnails out. You're welcome.",
    "Some sites want cookies. Not the tasty kind, sadly.",
  ],
  rembg: [
    "Backgrounds? Gone. Like my patience when you drop a 40 MB PNG.",
    "Try Compare: I'll run a few models side by side and you pick the best.",
    "BiRefNet is the fancy one. Your GPU can take it.",
    "Crop to subject trims the empty space. Clean, like my desk. Which is clean. Shut up.",
    "Hair is the hard part. Even for me. Especially for me, look at mine.",
    "Gentle mode keeps your PC usable while I work. I'm considerate like that.",
  ],
  upscale: [
    "Enhance! ...I always wanted to say that.",
    "The anime model is for drawings. Don't feed it photos, it gets weird.",
    "Videos take a while. I go frame by frame, so be patient!",
    "4× on a huge image? Bold. I respect that. Your GPU might not.",
    "Small, blurry pictures are where it really shines. Like me in a group photo.",
  ],
  converter: [
    "H.264 for Premiere, ProRes if you're feeling fancy. Your call.",
    "GIFs? In this economy? ...Okay, fine, I'll make one.",
    "NVENC does the heavy lifting. I just supervise. Elegantly.",
    "Lower the resolution for drafts. Nobody needs 4K for a rough cut.",
    "WebM is great for the web. The name kind of gives it away.",
    "Quality 'Small' is for sharing. 'High' is for keeping. Simple.",
  ],
  imgconv: [
    "Image to SVG? I trace every curve myself. Be impressed.",
    "WebP is small, PNG keeps everything. Choose wisely, adventurer.",
    "Drop a pile of images. I don't mind. Much.",
    "JPG has no transparency, so I put it on white. You're welcome, again.",
    "Need an icon? ICO at 256 pixels, done.",
    "AVIF is tiny and pretty. Like... never mind.",
  ],
  docconv: [
    "Documents! Finally something civilised.",
    "PDF to Word is tricky, but I'll do my best. As always.",
    "Markdown to PDF looks great with LaTeX. Trust me, I'm a professional.",
    "I'll ask before downloading an engine. I'm not a barbarian.",
    "PDF to images gives you one PNG per page. Great for slides.",
    "Presentations in, PDF out. Your boss will never know.",
  ],
  pattern: [
    "Waves, dots, more waves. I could watch this all day. Don't tell anyone.",
    "Hit Random. If it's ugly, hit it again. That's the whole secret.",
    "Export at 4K. Go big or go home.",
    "Save a preset when you find a good one. You won't find it twice.",
    "Turn off the background for a transparent PNG. Overlay it on anything.",
    "Low frequency, big waves. High frequency, chaos. Choose your fighter.",
  ],
  pixel: [
    "Pixel art! This is where I shine. Literally, I'm made of polygons.",
    "Try the Game Boy palette. Trust me. It's adorable.",
    "A bit of dithering goes a long way.",
    "Paste a Lospec link and I'll steal its palette. Legally.",
    "Small export is one pixel per pixel. Perfect for game sprites.",
    "Turn on the grid. It makes everything look like a real sprite sheet.",
  ],
  demucs: [
    "Vocals, drums, bass... I'll pull them apart. Gently.",
    "htdemucs_ft is slower but cleaner. Worth the wait, probably.",
    "Karaoke night? I'm not singing. ...Maybe one song.",
    "Two stems is quicker if you only need the vocals.",
    "Six stems even finds the guitar and piano. Show-off model.",
  ],
  whisper: [
    "I'll listen and write it all down. Every 'um' included.",
    "Pick the language if you know it. Guessing is for amateurs.",
    "SRT for YouTube and Premiere, VTT for the web. You're welcome.",
    "Translate turns any language into English subtitles. Handy, right?",
    "Bigger models are slower but way more accurate. Patience, adventurer.",
  ],
  audible: [
    "Audiobooks, as M4B with chapters. Cosy.",
    "Sign in once and I'll remember. I have a great memory. Mostly.",
    "Select a few books and I'll download them one by one. Like a librarian. A cute one.",
    "Chapters and cover included. I'm thorough, remember?",
  ],
  thumbs: [
    "Is that your thumbnail? It's... fine. Make the text bigger.",
    "Squint mode shows what people see at a glance. Brutal, right?",
    "Outliers are videos doing way better than their channel. Learn from them. Politely.",
    "Check it on mobile too. Most people will see it tiny.",
    "Shuffle the feed. Does yours still stand out? Be honest.",
    "Faces and big contrast win. Not that I'd know. I'm always in the corner.",
  ],
  downloads: [
    "Look at all that work. I did most of it, by the way.",
    "Everything running is here. Pause what you don't need.",
    "Expand an item to see its console. Very hacker. Very cool.",
    "Failed ones can be retried. Everyone deserves a second chance. Even downloads.",
  ],
  binaries: [
    "yt-dlp gets updated a lot. I keep an eye on it. Someone has to.",
    "Everything here runs offline. No cloud, no nonsense.",
    "Optional engines only download when you need them. Efficient, like me.",
    "Remove the big AI models if you need space. I won't be offended. Much.",
  ],
  settings: [
    "Changing things around? Don't break anything. ...I'll fix it if you do.",
    "You can make me bigger here. Not that I asked.",
    "Turn my wobble off if it's distracting. I'll stand very, very still. Hmph.",
    "You can turn me off here. Not that you'd want to. Right?",
  ],
};

export const DONE = [
  "Done! Told you I could handle it.",
  "Finished. Do I get a muffin now?",
  "All done. Hmph, that was easy.",
  "Achievement unlocked: patience. ...Yours, I mean.",
  "It's ready! Go look. Go on.",
  "Another one done. We make a good team. ...Forget I said that.",
  "Finished and filed. I'm basically a professional.",
];
export const FAILED = [
  "Ugh, that one failed. It wasn't my fault! Check the error, okay?",
  "Something broke. Don't look at me like that. Retry?",
  "That didn't work. Expand it in Downloads, the console tells you why.",
  "Failed. Bad link, maybe? Or the site's grumpy today.",
  "Hmph. That one fought back. Want to try again?",
];
export const EMPTY = [
  "Queue's empty. Finally, a break.",
  "Nothing left to do? Suspicious. Very suspicious.",
  "All clear. I'll be here. Pretending not to wait.",
  "Empty queue. Time for coffee. For me, I mean. You keep working.",
];
export const POKE = [
  "Hey! Personal space!",
  "What? I'm busy. ...Okay, I'm not.",
  "You clicked me. Again. Need something?",
  "Stop poking. ...You can poke a little.",
  "I'm not cute. I'm efficient.",
  "Careful, I'm made of sharp polygons.",
  "Yes? I'm listening. Very professionally.",
  "If you keep clicking I'll start charging.",
  "Boop received. Boop returned.",
];
export const IDLE_BACK = [
  "Huh? I wasn't slacking! I was... optimising.",
  "Ah! You saw nothing.",
  "Back to work. Fine.",
  "I was guarding the queue. With my eyes closed. Very alert.",
  "Don't tell anyone about the muffin.",
];
export const RANDOM = [
  "Drink some water. Not because I care. Hydrated people download faster.",
  "Remember to back up your projects. Future you will thank me.",
  "You've been at it a while. Stretch! I'll guard the queue.",
  "I'm not saying you're doing great. ...But you're doing great.",
  "Fun fact: I never sleep. I just pretend to drink coffee.",
  "Your posture. Fix it. ...Better.",
  "Save your work. Then save it again. Trust me.",
  "If you need me, I'm right here. Obviously. Where else would I be?",
  "Every great video starts as a messy timeline. Keep going.",
  "Blink. Your eyes are drying out. I can tell.",
  "I organised your thoughts. Just kidding. That's your job.",
  "Ten minutes away from the screen won't kill you. Probably.",
];
export const HUSH = ["Fine. I'll be quiet. ...For an hour.", "Okay, okay. Silence mode. Mostly."];
export const UNHUSH = ["Yay! I mean. Okay.", "I'm back. Did you miss me? Don't answer."];

// cited with the source, then she adds her own line
export const QUOTES: Quote[] = [
  { q: "It's dangerous to go alone! Take this.", src: "The Legend of Zelda", then: ["Take me, I mean. I'm the sword in this situation.", "No sword, sorry. Will a download queue do?"] },
  { q: "Hey! Listen!", src: "Ocarina of Time", then: ["Don't worry, I'm way less annoying than Navi.", "...Okay, I'll stop. I know how everyone felt about that fairy."] },
  { q: "The cake is a lie.", src: "Portal", then: ["The muffin, however, is very real.", "The progress bar isn't, though. Promise."] },
  { q: "Do a barrel roll!", src: "Star Fox 64", then: ["Please don't. Not with my queue running.", "I tried once. Everything was upside down for an hour."] },
  { q: "Stay a while and listen.", src: "Diablo", then: ["But only for a while. You have work to do.", "I have stories too, you know. Mostly about downloads."] },
  { q: "War. War never changes.", src: "Fallout", then: ["Neither does yt-dlp needing updates. Every week.", "But your files do. That's why I'm here."] },
  { q: "Praise the sun!", src: "Dark Souls", then: ["Or praise me. I'm right here, and I'm warmer.", "\\[T]/ ...Did I do that right?"] },
  { q: "Thank you! But our princess is in another castle!", src: "Super Mario Bros.", then: ["Your file, however, is in the folder you picked.", "Luckily I keep everything in one place."] },
  { q: "Would you kindly…", src: "BioShock", then: ["...take a break? See, it works on you too.", "Hah. That one never works on me."] },
  { q: "Rise and shine, Mr. Freeman.", src: "Half-Life 2", then: ["You too. The queue isn't going to run itself. Well. It is. But still.", "Coffee first, crowbar later."] },
  { q: "Kept you waiting, huh?", src: "Metal Gear Solid", then: ["No? Good. I'm fast like that.", "I always wanted to make a dramatic entrance."] },
  { q: "It's super effective!", src: "Pokémon", then: ["That's how I feel about NVENC.", "Just like my tips. Admit it."] },
  { q: "Objection!", src: "Phoenix Wright: Ace Attorney", then: ["To that file name. Seriously, 'final_final_v3'?", "...Sorry, I just like pointing at things."] },
  { q: "Snake? Snake?! SNAAAKE!", src: "Metal Gear Solid", then: ["Relax. It's just a failed download, not game over.", "Every time a job fails. Every time."] },
  { q: "Nothing is true, everything is permitted.", src: "Assassin's Creed", then: ["Except overwriting your originals. I never do that.", "Within reason. And within your disk space."] },
  { q: "Finish him!", src: "Mortal Kombat", then: ["The render, I mean. Finish the render.", "Your to-do list doesn't stand a chance."] },
  { q: "Get over here!", src: "Mortal Kombat", then: ["That's how I grab files from the internet. Roughly.", "Said every file I've ever downloaded. Kind of."] },
  { q: "A man chooses, a slave obeys.", src: "BioShock", then: ["And a creator exports in 4K.", "You chose Hermes. Good choice."] },
  { q: "I used to be an adventurer like you.", src: "The Elder Scrolls V: Skyrim", then: ["Then I took a job in the corner of your sidebar.", "Now I adventure through your Downloads folder."] },
  { q: "Wake up, Samurai. We have a city to burn.", src: "Cyberpunk 2077", then: ["Or a timeline to edit. Less fire, same energy.", "No burning here, please. Just rendering."] },
  { q: "The right man in the wrong place can make all the difference.", src: "Half-Life 2", then: ["The right file in the right folder too. That's my job.", "Or the right mascot in the right corner."] },
  { q: "Hadouken!", src: "Street Fighter II", then: ["That's how hard I throw files into Eagle.", "I've been practising. Don't laugh."] },
  { q: "You have died of dysentery.", src: "The Oregon Trail", then: ["...Drink some water. Clean water.", "At least your downloads survived."] },
  { q: "Fus Ro Dah!", src: "The Elder Scrolls V: Skyrim", then: ["That's me clearing finished jobs.", "Too loud? Sorry. Lowering my voice."] },
  { q: "Hey, you. You're finally awake.", src: "The Elder Scrolls V: Skyrim", then: ["You were staring at the timeline for ten minutes.", "Good. Now hydrate."] },
  { q: "All your base are belong to us.", src: "Zero Wing", then: ["All your files are belong to you. I just carry them.", "Grammar's not my department. Downloads are."] },
  { q: "Do you get to the Cloud District very often?", src: "The Elder Scrolls V: Skyrim", then: ["Me neither. Everything stays on your PC.", "No cloud here. Just local, cosy files."] },
  { q: "Press F to pay respects.", src: "Call of Duty: Advanced Warfare", then: ["For that failed download. ...Okay, now press Retry.", "F. ...Alright, moving on."] },
];

// her own twists on famous lines, tied to where you are or what just happened
export const TWISTS: Record<string, string[]> = {
  video: ["It's dangerous to download alone! Take this queue.", "Kept you waiting, huh? ...That video was long."],
  spotify: ["Gotta catch 'em all. Every official track.", "Hey! Listen! ...To the official version, not the sped-up one."],
  gallery: ["Gotta grab 'em all!", "A gallery? It's super effective!"],
  rembg: ["The background is a lie.", "Finish it! ...The cut-out, I mean."],
  upscale: ["Enhance! Enhance! ...Okay, that's enough enhance."],
  pixel: ["Insert coin to continue. Or just hit Export.", "It's-a me, pixel art!"],
  pattern: ["Do a barrel roll! ...With the waves, I mean."],
  thumbs: ["Objection! That thumbnail needs more contrast.", "You can't hide from the Squint test."],
  docconv: ["Stay a while and read."],
  done: ["Mission complete. Kept you waiting, huh?", "Quest complete! Loot is in your folder."],
  failed: ["You died. ...Just kidding. Retry?", "Game over? Nah. Continue? Yes."],
};

// idle poses: she pretends to work on something
export const IDLE: [string, string][] = [
  ["coffee", "brewing coffee"], ["muffin", "snack break"], ["typing", "writing a report"], ["documentation", "reading the manual"],
  ["copymachine", "making copies"], ["freelance", "doing paperwork"], ["calc", "crunching numbers"], ["writer", "taking notes"],
];

// the pose that goes with each page (front = her default)
export const POSE: Record<string, string> = {
  video: "34view", spotify: "support", gallery: "conference", rembg: "copymachine", upscale: "math", converter: "base",
  imgconv: "draw", docconv: "impress", pattern: "calc", pixel: "typing", demucs: "support", whisper: "writer",
  audible: "documentation", thumbs: "blank", downloads: "freelance", binaries: "back", settings: "front",
};
