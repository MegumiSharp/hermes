fn main() {
    // ONNX Runtime imports DirectML.dll. Delay-load it so Hermes can load the bundled copy from
    // hermes-data/bin (rembg::load_directml) instead of an older System32 one, and so a missing
    // DLL never stops the app from starting.
    println!("cargo:rustc-link-arg-bins=/DELAYLOAD:DirectML.dll");
    println!("cargo:rustc-link-arg-bins=delayimp.lib");
    tauri_build::build()
}
