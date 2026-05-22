//! File-type inference. Mirrors `packages/shared/src/schema/files.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Tex,
    Bib,
    Image,
    Other,
}

const TEX_EXTS: &[&str] = &["tex", "sty", "cls", "tikz", "latex"];
const BIB_EXTS: &[&str] = &["bib"];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "eps"];

pub fn infer_file_type(path: &str) -> FileType {
    let ext = match path.rsplit_once('.') {
        Some((_, ext)) => ext.to_ascii_lowercase(),
        None => return FileType::Other,
    };
    if TEX_EXTS.contains(&ext.as_str()) {
        FileType::Tex
    } else if BIB_EXTS.contains(&ext.as_str()) {
        FileType::Bib
    } else if IMAGE_EXTS.contains(&ext.as_str()) {
        FileType::Image
    } else {
        FileType::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_tex_family() {
        assert_eq!(infer_file_type("main.tex"), FileType::Tex);
        assert_eq!(infer_file_type("sections/intro.tex"), FileType::Tex);
        assert_eq!(infer_file_type("custom.cls"), FileType::Tex);
        assert_eq!(infer_file_type("custom.sty"), FileType::Tex);
    }

    #[test]
    fn infers_bib() {
        assert_eq!(infer_file_type("refs.bib"), FileType::Bib);
    }

    #[test]
    fn infers_image() {
        assert_eq!(infer_file_type("fig.PNG"), FileType::Image);
        assert_eq!(infer_file_type("fig.svg"), FileType::Image);
    }

    #[test]
    fn falls_back_to_other() {
        assert_eq!(infer_file_type("README"), FileType::Other);
        assert_eq!(infer_file_type("data.csv"), FileType::Other);
    }
}
