//! Prints the lines of standard input that mishear can read: every word
//! pronounced by CMUdict or derived from it by mime-reader's productive rules
//! (possessives, plurals, -ly, -less, -ness, -ful, ...), as the engine reads a
//! line. scripts/gatsby_lines.py filters its sentences through it.
//!
//! ```sh
//! cargo run --release -p mishear --example readable_lines < candidates.txt
//! ```

use std::io::{BufRead, Write};
use std::path::Path;

use mime_reader::{CmuDictionary, Line, PronouncingDictionary, PronunciationMode};

fn main() -> Result<(), String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dict = CmuDictionary::load(root.join("data/CMUdict/cmudict-0.7b"))
        .map_err(|e| e.to_string())?
        .with_pronunciation_mode(PronunciationMode::AllowDerived);
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in std::io::stdin().lock().lines() {
        let text = line.map_err(|e| e.to_string())?;
        let read = Line::new(&text, &dict);
        if !read.words.is_empty() && read.unknown_words().is_empty() {
            writeln!(out, "{text}").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
