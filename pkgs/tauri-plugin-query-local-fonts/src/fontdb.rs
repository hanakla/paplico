use crate::{FontRecord, LocalFont};
use fontdb::{Database, Source};
use ttf_parser::{name_id, Face, Language, PlatformId};

/// Lists the fonts in the directories fontconfig names, falling back to the
/// usual font directories.
pub fn enumerate() -> Vec<LocalFont> {
    let mut db = Database::new();
    db.load_system_fonts();
    db.faces()
        .filter_map(|info| {
            let Source::File(path) = &info.source else {
                return None;
            };
            let names = db.with_face_data(info.id, |data, index| {
                let face = Face::parse(data, index).ok()?;
                let name = |ids: &[u16]| ids.iter().find_map(|&id| english_name(&face, id));
                Some((
                    name(&[name_id::FULL_NAME])?,
                    name(&[name_id::TYPOGRAPHIC_SUBFAMILY, name_id::SUBFAMILY])?,
                ))
            })??;
            Some(LocalFont {
                record: FontRecord {
                    family: info.families.first()?.0.clone(),
                    full_name: names.0,
                    postscript_name: info.post_script_name.clone(),
                    style: names.1,
                },
                path: path.clone(),
            })
        })
        .collect()
}

/// The English name with `id`, or the first one that decodes. Older fonts
/// keep their English names only in the Macintosh Roman record.
fn english_name(face: &Face, id: u16) -> Option<String> {
    let names = || face.names().into_iter().filter(|n| n.name_id == id);
    names()
        .find(|n| n.language() == Language::English_UnitedStates)
        .and_then(|n| n.to_string())
        .or_else(|| {
            names()
                .find(|n| {
                    n.platform_id == PlatformId::Macintosh
                        && n.encoding_id == 0
                        && n.language_id == 0
                })
                .filter(|n| n.name.is_ascii())
                .map(|n| n.name.iter().map(|&b| b as char).collect())
        })
        .or_else(|| names().find_map(|n| n.to_string()))
}
