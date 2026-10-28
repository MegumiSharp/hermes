//! Raster image → SVG (Image Converter "SVG (vector)"), in process with vtracer. Big images are
//! scaled to MAX_SIDE first: tracing time grows with pixels and a logo/illustration loses nothing.
use image::imageops::FilterType;

const MAX_SIDE: u32 = 2000;

/// `mode`: "color" | "bw"; `detail`: "high" | "balanced" | "simple".
pub fn trace(input: &str, output: &str, mode: &str, detail: &str) -> Result<(), String> {
    let mut img = image::open(input).map_err(|e| format!("Cannot read the image: {e}"))?;
    if img.width().max(img.height()) > MAX_SIDE {
        img = img.resize(MAX_SIDE, MAX_SIDE, FilterType::Lanczos3);
    }
    let rgba = img.to_rgba8();
    let picture = vtracer::ColorImage { pixels: rgba.as_raw().to_vec(), width: rgba.width() as usize, height: rgba.height() as usize };
    // more colours / smaller speckles / finer paths = more faithful, bigger file
    let (precision, speckle, layers, path) = match detail {
        "high" => (8, 2, 8, 3),
        "simple" => (4, 12, 32, 1),
        _ => (6, 4, 16, 2),
    };
    let config = vtracer::Config {
        color_mode: if mode == "bw" { vtracer::ColorMode::Binary } else { vtracer::ColorMode::Color },
        hierarchical: vtracer::Hierarchical::Stacked,
        filter_speckle: speckle,
        color_precision: precision,
        layer_difference: layers,
        path_precision: Some(path),
        ..vtracer::Config::default()
    };
    let svg = vtracer::convert(picture, config)?;
    std::fs::write(output, svg.to_string()).map_err(|e| format!("Cannot save the SVG: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn traces_a_png() {
        let dir = std::env::temp_dir().join("hermes-vector-test");
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("in.png");
        let mut img = image::RgbaImage::from_pixel(64, 64, image::Rgba([255, 255, 255, 255]));
        for y in 16..48 {
            for x in 16..48 {
                img.put_pixel(x, y, image::Rgba([200, 30, 30, 255]));
            }
        }
        img.save(&png).unwrap();
        let svg = dir.join("out.svg");
        super::trace(png.to_str().unwrap(), svg.to_str().unwrap(), "color", "balanced").unwrap();
        let text = std::fs::read_to_string(&svg).unwrap();
        assert!(text.starts_with("<?xml") && text.contains("<path"), "{text}");
        assert!(text.to_lowercase().contains("#c81e1e"), "red square traced: {text}");
    }
}
