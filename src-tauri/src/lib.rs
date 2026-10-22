use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;
const PROC_FLAGS: u32 = CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS;

fn hash_password(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"lms_explorer_salt_");
    hasher.update(password.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Comparação de strings em tempo constante para mitigar ataques de temporização (Timing Attacks)
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VideoItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub folder_origin: String,
    pub size_bytes: u64,
    pub modified: u64,
    pub duration_secs: u64,
    #[serde(default)]
    pub duration_probed: bool,
    pub thumbnail: Option<String>,
    pub scrub_sprite: Option<String>,
    pub is_favorite: bool,
    pub tags: Vec<String>,
    #[serde(default)]
    pub play_count: u64,
    #[serde(default)]
    pub last_played: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VideoPlayInfo {
    pub play_count: u64,
    pub last_played: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub folders_count: usize,
    #[serde(default)]
    pub files_count: usize,
    pub created_at: u64,
    #[serde(default)]
    pub is_locked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectDetails {
    pub id: String,
    pub name: String,
    pub folders: Vec<String>,
    #[serde(default)]
    pub individual_files: Vec<String>,
    pub created_at: u64,
    pub include_subfolders: bool,
    pub favorites: HashSet<String>,
    pub tags: HashMap<String, Vec<String>>,
    pub available_tags: Vec<String>,
    pub durations: HashMap<String, u64>,
    #[serde(default)]
    pub play_counts: HashMap<String, u64>,
    #[serde(default)]
    pub last_played: HashMap<String, u64>,
    #[serde(default)]
    pub sort_mode: Option<String>,
    #[serde(default)]
    pub grid_size: Option<String>,
    #[serde(default)]
    pub view_mode: Option<String>,
    #[serde(default)]
    pub group_by: Option<String>,
    #[serde(default)]
    pub password_hash: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectViewResult {
    pub project_id: String,
    pub project_name: String,
    pub folders: Vec<String>,
    #[serde(default)]
    pub individual_files: Vec<String>,
    pub include_subfolders: bool,
    pub videos: Vec<VideoItem>,
    pub available_tags: Vec<String>,
    #[serde(default)]
    pub sort_mode: Option<String>,
    #[serde(default)]
    pub grid_size: Option<String>,
    #[serde(default)]
    pub view_mode: Option<String>,
    #[serde(default)]
    pub group_by: Option<String>,
    #[serde(default)]
    pub is_locked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncReport {
    pub added_count: usize,
    pub removed_count: usize,
    pub total_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectStats {
    pub total_videos: usize,
    pub total_size_bytes: u64,
    pub total_duration_secs: u64,
    pub total_favorites: usize,
    #[serde(default)]
    pub total_plays: u64,
    pub top_tags: Vec<(String, usize)>,
    pub folders_summary: Vec<(String, usize)>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ThumbGenResult {
    pub thumbnail: String,
    pub scrub_sprite: Option<String>,
    pub duration_secs: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DuplicateGroup {
    pub key: String,
    pub match_type: String,
    pub total_size_bytes: u64,
    pub items: Vec<VideoItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileOperationResult {
    pub success_paths: Vec<String>,
    pub failed_paths: Vec<(String, String)>,
}

fn get_app_storage_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let app_dir = base.join("lms-explorer");
    let projects_dir = app_dir.join("projects");
    let thumbs_dir = app_dir.join("thumbnails");

    let _ = fs::create_dir_all(&projects_dir);
    let _ = fs::create_dir_all(&thumbs_dir);

    app_dir
}

static PROJECT_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn get_project_file_path(project_id: &str) -> PathBuf {
    get_app_storage_dir().join("projects").join(format!("{}.json", project_id))
}

fn load_project_details(project_id: &str) -> Result<ProjectDetails, String> {
    let file_path = get_project_file_path(project_id);
    if !file_path.exists() {
        return Err("Projeto não encontrado".into());
    }
    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut details: ProjectDetails = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if !content.contains("include_subfolders") {
        details.include_subfolders = true;
    }
    Ok(details)
}

fn save_project_details(details: &ProjectDetails) -> Result<(), String> {
    let file_path = get_project_file_path(&details.id);
    let tmp_path = file_path.with_extension("json.tmp");
    let json_data = serde_json::to_string_pretty(details).map_err(|e| e.to_string())?;

    // Escrita atômica: escreve no .tmp e substitui atomicamente para evitar arquivos zerados/corrompidos
    fs::write(&tmp_path, json_data).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp_path, &file_path) {
        let _ = fs::copy(&tmp_path, &file_path);
        let _ = fs::remove_file(&tmp_path);
        if !file_path.exists() {
            return Err(e.to_string());
        }
    }
    Ok(())
}

fn hash_path(path: &str) -> String {
    let mut sum: u64 = 5381;
    for b in path.bytes() {
        sum = ((sum << 5).wrapping_add(sum)).wrapping_add(b as u64);
    }
    format!("{:x}", sum)
}

fn probe_video_duration(video_path: &str) -> u64 {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            video_path,
        ])
        .creation_flags(PROC_FLAGS)
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let str_val = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(secs) = str_val.parse::<f64>() {
                return secs.round() as u64;
            }
        }
    }
    0
}

// -------------------------------------------------------------
// COMANDOS DE PROJETOS & VARREDURA LEVE
// -------------------------------------------------------------

#[tauri::command]
fn list_projects() -> Result<Vec<ProjectSummary>, String> {
    let projects_dir = get_app_storage_dir().join("projects");
    let mut list = Vec::new();

    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(details) = serde_json::from_str::<ProjectDetails>(&content) {
                        let is_locked = details.password_hash.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);
                        list.push(ProjectSummary {
                            id: details.id,
                            name: details.name,
                            folders_count: details.folders.len(),
                            files_count: details.individual_files.len(),
                            created_at: details.created_at,
                            is_locked,
                        });
                    }
                }
            }
        }
    }

    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

#[tauri::command]
fn create_project(name: String) -> Result<ProjectDetails, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("O nome do projeto não pode ser vazio".into());
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let id = format!("proj_{}_{}", now, hash_path(trimmed));

    let details = ProjectDetails {
        id,
        name: trimmed.to_string(),
        folders: Vec::new(),
        individual_files: Vec::new(),
        created_at: now,
        include_subfolders: true,
        favorites: HashSet::new(),
        tags: HashMap::new(),
        available_tags: Vec::new(),
        durations: HashMap::new(),
        play_counts: HashMap::new(),
        last_played: HashMap::new(),
        sort_mode: Some("name-asc".into()),
        grid_size: Some("medium".into()),
        view_mode: Some("grid".into()),
        group_by: Some("none".into()),
        password_hash: None,
    };

    save_project_details(&details)?;
    Ok(details)
}

#[tauri::command]
fn delete_project(project_id: String) -> Result<(), String> {
    let file_path = get_project_file_path(&project_id);
    if file_path.exists() {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rename_project(project_id: String, new_name: String) -> Result<ProjectDetails, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("O novo nome do projeto não pode ser vazio".into());
    }
    let mut details = load_project_details(&project_id)?;
    details.name = trimmed.to_string();
    save_project_details(&details)?;
    Ok(details)
}

#[tauri::command]
fn update_project_settings(
    project_id: String,
    sort_mode: Option<String>,
    grid_size: Option<String>,
    view_mode: Option<String>,
    group_by: Option<String>,
) -> Result<(), String> {
    let mut details = load_project_details(&project_id)?;
    if let Some(sm) = sort_mode {
        details.sort_mode = Some(sm);
    }
    if let Some(gs) = grid_size {
        details.grid_size = Some(gs);
    }
    if let Some(vm) = view_mode {
        details.view_mode = Some(vm);
    }
    if let Some(gb) = group_by {
        details.group_by = Some(gb);
    }
    save_project_details(&details)?;
    Ok(())
}

#[tauri::command]
fn record_video_play(project_id: String, video_path: String) -> Result<VideoPlayInfo, String> {
    let _guard = PROJECT_MUTEX.lock().unwrap();
    let mut details = load_project_details(&project_id)?;

    let count = details.play_counts.entry(video_path.clone()).or_insert(0);
    *count += 1;
    let new_count = *count;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    details.last_played.insert(video_path, now);

    save_project_details(&details)?;

    Ok(VideoPlayInfo {
        play_count: new_count,
        last_played: now,
    })
}

#[tauri::command]
fn add_folder_to_project(project_id: String, folder_path: String) -> Result<ProjectDetails, String> {
    let mut details = load_project_details(&project_id)?;
    if !details.folders.contains(&folder_path) {
        details.folders.push(folder_path);
        save_project_details(&details)?;
    }
    Ok(details)
}

#[tauri::command]
fn add_folders_to_project(project_id: String, folder_paths: Vec<String>) -> Result<ProjectDetails, String> {
    let mut details = load_project_details(&project_id)?;
    let mut changed = false;
    for fp in folder_paths {
        if !details.folders.contains(&fp) {
            details.folders.push(fp);
            changed = true;
        }
    }
    if changed {
        save_project_details(&details)?;
    }
    Ok(details)
}

#[tauri::command]
fn add_project_tag(project_id: String, tag: String) -> Result<Vec<String>, String> {
    let clean = tag.trim().to_lowercase().replace(' ', "-");
    if clean.is_empty() {
        return Err("A tag não pode ser vazia".into());
    }
    let mut details = load_project_details(&project_id)?;
    if !details.available_tags.contains(&clean) {
        details.available_tags.push(clean);
        details.available_tags.sort();
        save_project_details(&details)?;
    }
    Ok(details.available_tags)
}

#[tauri::command]
fn remove_project_tag(project_id: String, tag: String) -> Result<Vec<String>, String> {
    let clean = tag.trim().to_lowercase();
    let mut details = load_project_details(&project_id)?;
    details.available_tags.retain(|t| t != &clean);
    for tags in details.tags.values_mut() {
        tags.retain(|t| t != &clean);
    }
    save_project_details(&details)?;
    Ok(details.available_tags)
}

#[tauri::command]
fn remove_folder_from_project(project_id: String, folder_path: String) -> Result<ProjectDetails, String> {
    let mut details = load_project_details(&project_id)?;
    details.folders.retain(|f| f != &folder_path);
    save_project_details(&details)?;
    Ok(details)
}

#[tauri::command]
fn remove_folders_from_project(
    project_id: String,
    folder_paths: Vec<String>,
) -> Result<ProjectDetails, String> {
    let _guard = PROJECT_MUTEX.lock().unwrap();
    let mut details = load_project_details(&project_id)?;
    let to_remove: HashSet<String> = folder_paths.into_iter().collect();
    details.folders.retain(|f| !to_remove.contains(f));
    save_project_details(&details)?;
    Ok(details)
}

#[tauri::command]
fn toggle_subfolders(project_id: String, include_subfolders: bool) -> Result<bool, String> {
    let mut details = load_project_details(&project_id)?;
    details.include_subfolders = include_subfolders;
    save_project_details(&details)?;
    Ok(details.include_subfolders)
}

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "webm", "flv", "m4v", "ts", "m2ts",
];

#[tauri::command]
fn add_dropped_paths(project_id: String, paths: Vec<String>) -> Result<ProjectViewResult, String> {
    let mut details = load_project_details(&project_id)?;
    let mut changed = false;

    for p_str in paths {
        let p = Path::new(&p_str);
        if p.is_dir() {
            if !details.folders.contains(&p_str) {
                details.folders.push(p_str);
                changed = true;
            }
        } else if p.is_file() {
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if VIDEO_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                    if !details.individual_files.contains(&p_str) {
                        details.individual_files.push(p_str);
                        changed = true;
                    }
                }
            }
        }
    }

    if changed {
        save_project_details(&details)?;
    }

    load_project_videos_internal(&details)
}

#[tauri::command]
fn add_individual_files(project_id: String, files: Vec<String>) -> Result<ProjectViewResult, String> {
    let mut details = load_project_details(&project_id)?;
    let mut changed = false;

    for f_str in files {
        let p = Path::new(&f_str);
        if p.is_file() {
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if VIDEO_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                    if !details.individual_files.contains(&f_str) {
                        details.individual_files.push(f_str);
                        changed = true;
                    }
                }
            }
        }
    }

    if changed {
        save_project_details(&details)?;
    }

    load_project_videos_internal(&details)
}

#[tauri::command]
fn remove_individual_file(project_id: String, file_path: String) -> Result<ProjectDetails, String> {
    let mut details = load_project_details(&project_id)?;
    details.individual_files.retain(|f| f != &file_path);
    save_project_details(&details)?;
    Ok(details)
}

fn process_video_path(
    path: &Path,
    folder_origin: String,
    details: &ProjectDetails,
    thumbs_dir: &Path,
    seen_paths: &mut HashSet<String>,
) -> Option<VideoItem> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    if !VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }

    let file_path_str = path.to_string_lossy().to_string();
    if !seen_paths.insert(file_path_str.clone()) {
        return None;
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Sem Nome".into());

    let metadata = path.metadata().ok();
    let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = metadata
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let is_favorite = details.favorites.contains(&file_path_str);
    let item_tags = details.tags.get(&file_path_str).cloned().unwrap_or_default();
    let duration_probed = details.durations.contains_key(&file_path_str);
    let duration_secs = details.durations.get(&file_path_str).copied().unwrap_or(0);

    let hash = hash_path(&file_path_str);
    let thumb_file = thumbs_dir.join(format!("{}.webp", hash));
    let scrub_file = thumbs_dir.join(format!("{}_scrub.webp", hash));

    let thumbnail_path = if thumb_file.exists() {
        Some(thumb_file.to_string_lossy().to_string())
    } else {
        None
    };

    let scrub_sprite_path = if scrub_file.exists() {
        Some(scrub_file.to_string_lossy().to_string())
    } else {
        None
    };

    let play_count = details.play_counts.get(&file_path_str).copied().unwrap_or(0);
    let last_played = details.last_played.get(&file_path_str).copied();

    Some(VideoItem {
        id: hash,
        name: file_name,
        path: file_path_str,
        folder_origin,
        size_bytes,
        modified,
        duration_secs,
        duration_probed,
        thumbnail: thumbnail_path,
        scrub_sprite: scrub_sprite_path,
        is_favorite,
        tags: item_tags,
        play_count,
        last_played,
    })
}

/// Verifica se um arquivo ou diretório é oculto ou do sistema
fn is_hidden_or_system(entry: &walkdir::DirEntry) -> bool {
    // Não poda a pasta raiz vinculada pelo usuário (depth == 0)
    if entry.depth() == 0 {
        return false;
    }

    let file_name = entry.file_name().to_string_lossy();

    // 1. Arquivos ou diretórios que começam com ponto (ex: .git, .vscode, .thumbnails, etc.)
    if file_name.starts_with('.') {
        return true;
    }

    // 2. No Windows, verifica atributos nativos de arquivo oculto e de sistema
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(metadata) = entry.metadata() {
            let attrs = metadata.file_attributes();
            // 0x00000002 = FILE_ATTRIBUTE_HIDDEN
            // 0x00000004 = FILE_ATTRIBUTE_SYSTEM
            if (attrs & 0x00000002 != 0) || (attrs & 0x00000004 != 0) {
                return true;
            }
        }
    }

    false
}

fn load_project_videos_internal(details: &ProjectDetails) -> Result<ProjectViewResult, String> {
    let thumbs_dir = get_app_storage_dir().join("thumbnails");

    let mut videos = Vec::new();
    let mut seen_paths = HashSet::new();

    // 1. Processar pastas vinculadas
    for folder_str in &details.folders {
        let folder = Path::new(folder_str);
        if !folder.is_dir() {
            continue;
        }

        let mut builder = WalkDir::new(folder);
        if !details.include_subfolders {
            builder = builder.max_depth(1);
        }
        let walker = builder.into_iter().filter_entry(|e| !is_hidden_or_system(e));

        for entry in walker.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                if let Some(item) = process_video_path(
                    path,
                    folder_str.clone(),
                    details,
                    &thumbs_dir,
                    &mut seen_paths,
                ) {
                    videos.push(item);
                }
            }
        }
    }

    // 2. Processar arquivos individuais avulsos
    for file_str in &details.individual_files {
        let path = Path::new(file_str);
        if path.is_file() {
            let origin = path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "Arquivo Avulso".into());

            if let Some(item) = process_video_path(
                path,
                origin,
                details,
                &thumbs_dir,
                &mut seen_paths,
            ) {
                videos.push(item);
            }
        }
    }

    videos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let is_locked = details
        .password_hash
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    Ok(ProjectViewResult {
        project_id: details.id.clone(),
        project_name: details.name.clone(),
        folders: details.folders.clone(),
        individual_files: details.individual_files.clone(),
        include_subfolders: details.include_subfolders,
        videos,
        available_tags: details.available_tags.clone(),
        sort_mode: details.sort_mode.clone(),
        grid_size: details.grid_size.clone(),
        view_mode: details.view_mode.clone(),
        group_by: details.group_by.clone(),
        is_locked,
    })
}

#[tauri::command]
fn load_project_videos(
    project_id: String,
    password: Option<String>,
) -> Result<ProjectViewResult, String> {
    let details = load_project_details(&project_id)?;

    if let Some(ref hash) = details.password_hash {
        if !hash.trim().is_empty() {
            let pass = password.unwrap_or_default();
            let computed = hash_password(&pass);
            if !constant_time_eq(computed.as_bytes(), hash.as_bytes()) {
                return Err("PROJECT_LOCKED".into());
            }
        }
    }

    load_project_videos_internal(&details)
}

#[tauri::command]
fn set_project_password(
    project_id: String,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<(), String> {
    let _guard = PROJECT_MUTEX.lock().unwrap();
    let mut details = load_project_details(&project_id)?;

    if let Some(ref hash) = details.password_hash {
        if !hash.trim().is_empty() {
            let cur = current_password.unwrap_or_default();
            let computed = hash_password(&cur);
            if !constant_time_eq(computed.as_bytes(), hash.as_bytes()) {
                return Err("Senha atual incorreta.".into());
            }
        }
    }

    let trimmed = new_password.as_deref().map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        details.password_hash = None;
    } else {
        details.password_hash = Some(hash_password(trimmed));
    }

    save_project_details(&details)
}

#[tauri::command]
fn verify_project_password(project_id: String, password: String) -> Result<bool, String> {
    let details = load_project_details(&project_id)?;
    if let Some(ref hash) = details.password_hash {
        if !hash.trim().is_empty() {
            let computed = hash_password(&password);
            return Ok(constant_time_eq(computed.as_bytes(), hash.as_bytes()));
        }
    }
    Ok(true)
}

#[tauri::command]
fn rename_video_file(
    project_id: String,
    old_path: String,
    new_name: String,
) -> Result<VideoItem, String> {
    let _guard = PROJECT_MUTEX.lock().unwrap();
    let old_p = Path::new(&old_path);
    if !old_p.exists() || !old_p.is_file() {
        return Err("Arquivo de vídeo original não encontrado no disco".into());
    }

    let parent_dir = old_p.parent().ok_or("Diretório pai inválido")?;
    let old_ext = old_p.extension().and_then(|e| e.to_str()).unwrap_or("");

    let clean_name = new_name.trim().trim_matches(['.', ' ']);
    if clean_name.is_empty() {
        return Err("Nome do arquivo não pode ser vazio".into());
    }

    let invalid_chars = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    if clean_name.chars().any(|c| invalid_chars.contains(&c)) {
        return Err("O nome contém caracteres inválidos: \\ / : * ? \" < > |".into());
    }

    let reserved_names = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let base_check = clean_name.split('.').next().unwrap_or("").to_uppercase();
    if reserved_names.contains(&base_check.as_str()) {
        return Err("Este é um nome de dispositivo reservado pelo Windows e não pode ser utilizado".into());
    }

    let final_file_name = if clean_name.to_lowercase().ends_with(&format!(".{}", old_ext.to_lowercase())) {
        clean_name.to_string()
    } else {
        format!("{}.{}", clean_name, old_ext)
    };

    let new_p = parent_dir.join(&final_file_name);
    if new_p.exists() && new_p != old_p {
        return Err("Já existe um arquivo com esse nome nesta pasta".into());
    }

    if new_p != old_p {
        fs::rename(&old_p, &new_p).map_err(|e| format!("Falha ao renomear arquivo: {}", e))?;
    }

    let new_path_str = new_p.to_string_lossy().to_string();

    let mut details = load_project_details(&project_id)?;

    if details.favorites.remove(&old_path) {
        details.favorites.insert(new_path_str.clone());
    }

    if let Some(tags) = details.tags.remove(&old_path) {
        details.tags.insert(new_path_str.clone(), tags);
    }

    if let Some(dur) = details.durations.remove(&old_path) {
        details.durations.insert(new_path_str.clone(), dur);
    }

    if let Some(cnt) = details.play_counts.remove(&old_path) {
        details.play_counts.insert(new_path_str.clone(), cnt);
    }

    if let Some(lp) = details.last_played.remove(&old_path) {
        details.last_played.insert(new_path_str.clone(), lp);
    }

    for file in &mut details.individual_files {
        if *file == old_path {
            *file = new_path_str.clone();
        }
    }

    save_project_details(&details)?;

    let thumbs_dir = get_app_storage_dir().join("thumbnails");
    let old_hash = hash_path(&old_path);
    let new_hash = hash_path(&new_path_str);

    let old_thumb = thumbs_dir.join(format!("{}.webp", old_hash));
    let new_thumb = thumbs_dir.join(format!("{}.webp", new_hash));
    if old_thumb.exists() && old_hash != new_hash {
        let _ = fs::copy(&old_thumb, &new_thumb);
        let _ = fs::remove_file(&old_thumb);
    }

    let old_scrub = thumbs_dir.join(format!("{}_scrub.webp", old_hash));
    let new_scrub = thumbs_dir.join(format!("{}_scrub.webp", new_hash));
    if old_scrub.exists() && old_hash != new_hash {
        let _ = fs::copy(&old_scrub, &new_scrub);
        let _ = fs::remove_file(&old_scrub);
    }

    let mut seen = HashSet::new();
    let folder_origin = new_p
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let item = process_video_path(&new_p, folder_origin, &details, &thumbs_dir, &mut seen)
        .ok_or("Erro ao reprocessar vídeo renomeado")?;

    Ok(item)
}

// -------------------------------------------------------------
// SINCRONIZAÇÃO INTELIGENTE
// -------------------------------------------------------------
#[tauri::command]
fn sync_project(project_id: String) -> Result<SyncReport, String> {
    let mut details = load_project_details(&project_id)?;
    let mut current_disk_files = HashSet::new();

    for folder_str in &details.folders {
        let folder = Path::new(folder_str);
        if !folder.is_dir() {
            continue;
        }

        let mut builder = WalkDir::new(folder);
        if !details.include_subfolders {
            builder = builder.max_depth(1);
        }
        let walker = builder.into_iter().filter_entry(|e| !is_hidden_or_system(e));

        for entry in walker.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if VIDEO_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                        let path_str = path.to_string_lossy().to_string();
                        current_disk_files.insert(path_str);
                    }
                }
            }
        }
    }

    for file_str in &details.individual_files {
        let p = Path::new(file_str);
        if p.is_file() {
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if VIDEO_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                    current_disk_files.insert(file_str.clone());
                }
            }
        }
    }

    let initial_known_files: HashSet<String> = details
        .tags
        .keys()
        .chain(details.favorites.iter())
        .chain(details.durations.keys())
        .cloned()
        .collect();

    let mut removed_count = 0;
    details.favorites.retain(|path| {
        let exists = Path::new(path).exists();
        if !exists {
            removed_count += 1;
        }
        exists
    });

    details.tags.retain(|path, _| Path::new(path).exists());
    details.durations.retain(|path, _| Path::new(path).exists());
    details.play_counts.retain(|path, _| Path::new(path).exists());
    details.last_played.retain(|path, _| Path::new(path).exists());
    details.individual_files.retain(|path| Path::new(path).exists());

    let mut added_count = 0;
    for file in &current_disk_files {
        if !initial_known_files.contains(file) {
            added_count += 1;
        }
    }

    save_project_details(&details)?;

    Ok(SyncReport {
        added_count,
        removed_count,
        total_count: current_disk_files.len(),
    })
}

// -------------------------------------------------------------
// GERAÇÃO RÁPIDA DE THUMBNAIL (SEM BASE64 / STREAM NATIVO)
// -------------------------------------------------------------
fn generate_single_thumbnail_sync(
    project_id: String,
    video_path: String,
) -> Result<ThumbGenResult, String> {
    let thumbs_dir = get_app_storage_dir().join("thumbnails");
    let hash = hash_path(&video_path);
    let output_thumb = thumbs_dir.join(format!("{}.webp", hash));
    let output_scrub = thumbs_dir.join(format!("{}_scrub.webp", hash));

    // 1. Duração rápida e segura contra concorrência
    let existing_duration = {
        let _guard = PROJECT_MUTEX.lock().unwrap();
        load_project_details(&project_id)
            .ok()
            .and_then(|d| d.durations.get(&video_path).copied())
    };

    let duration = match existing_duration {
        Some(d) => d,
        None => probe_video_duration(&video_path),
    };

    // 2. Thumbnail Principal com Fast Demuxer Seek (< 30ms)
    if !output_thumb.exists() {
        let output_str = output_thumb.to_string_lossy().to_string();
        let _ = Command::new("ffmpeg")
            .args([
                "-y",
                "-nostats",
                "-loglevel", "error",
                "-threads", "1",
                "-an",
                "-sn",
                "-dn",
                "-ss", "00:00:02",
                "-noaccurate_seek",
                "-i", &video_path,
                "-vframes", "1",
                "-vf", "scale=320:-1:flags=fast_bilinear",
                "-q:v", "75",
                &output_str,
            ])
            .creation_flags(PROC_FLAGS)
            .status();

        if !output_thumb.exists() {
            let _ = Command::new("ffmpeg")
                .args([
                    "-y",
                    "-nostats",
                    "-loglevel", "error",
                    "-threads", "1",
                    "-an",
                    "-sn",
                    "-dn",
                    "-ss", "00:00:00",
                    "-i", &video_path,
                    "-vframes", "1",
                    "-vf", "scale=320:-1:flags=fast_bilinear",
                    "-q:v", "75",
                    &output_str,
                ])
                .creation_flags(PROC_FLAGS)
                .status();
        }
    }

    if output_thumb.exists() {
        let thumb_path_str = output_thumb.to_string_lossy().to_string();
        let scrub_path_str = if output_scrub.exists() {
            Some(output_scrub.to_string_lossy().to_string())
        } else {
            None
        };

        Ok(ThumbGenResult {
            thumbnail: thumb_path_str,
            scrub_sprite: scrub_path_str,
            duration_secs: duration,
        })
    } else {
        Err("Falha ao gerar miniatura".into())
    }
}

#[tauri::command]
async fn generate_single_thumbnail(
    project_id: String,
    video_path: String,
) -> Result<ThumbGenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        generate_single_thumbnail_sync(project_id, video_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn save_project_durations(
    project_id: String,
    durations: HashMap<String, u64>,
) -> Result<(), String> {
    let _guard = PROJECT_MUTEX.lock().unwrap();
    let mut details = load_project_details(&project_id)?;
    for (path, dur) in durations {
        details.durations.insert(path, dur);
    }
    save_project_details(&details)
}

// -------------------------------------------------------------
// HOVER SCRUBBING SOB DEMANDA (LAZY ON HOVER)
// -------------------------------------------------------------
fn generate_hover_scrub_sync(video_path: String, duration: u64) -> Result<String, String> {
    let thumbs_dir = get_app_storage_dir().join("thumbnails");
    let hash = hash_path(&video_path);
    let output_scrub = thumbs_dir.join(format!("{}_scrub.webp", hash));

    if output_scrub.exists() {
        return Ok(output_scrub.to_string_lossy().to_string());
    }

    if duration > 3 {
        let t1 = format!("{}", (duration as f64 * 0.2).round() as u64);
        let t2 = format!("{}", (duration as f64 * 0.4).round() as u64);
        let t3 = format!("{}", (duration as f64 * 0.6).round() as u64);
        let t4 = format!("{}", (duration as f64 * 0.8).round() as u64);
        let scrub_str = output_scrub.to_string_lossy().to_string();

        let _ = Command::new("ffmpeg")
            .args([
                "-y",
                "-nostats",
                "-loglevel", "error",
                "-threads", "1",
                "-an",
                "-sn",
                "-dn",
                "-ss", &t1, "-noaccurate_seek", "-i", &video_path,
                "-ss", &t2, "-noaccurate_seek", "-i", &video_path,
                "-ss", &t3, "-noaccurate_seek", "-i", &video_path,
                "-ss", &t4, "-noaccurate_seek", "-i", &video_path,
                "-filter_complex",
                "[0:v]scale=160:-1:flags=fast_bilinear[v0];\
                 [1:v]scale=160:-1:flags=fast_bilinear[v1];\
                 [2:v]scale=160:-1:flags=fast_bilinear[v2];\
                 [3:v]scale=160:-1:flags=fast_bilinear[v3];\
                 [v0][v1][v2][v3]hstack=inputs=4[out]",
                "-map", "[out]",
                "-vframes", "1",
                "-q:v", "65",
                &scrub_str,
            ])
            .creation_flags(PROC_FLAGS)
            .status();
    }

    if output_scrub.exists() {
        Ok(output_scrub.to_string_lossy().to_string())
    } else {
        Err("Não foi possível gerar preview de hover".into())
    }
}

#[tauri::command]
async fn generate_hover_scrub(video_path: String, duration: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        generate_hover_scrub_sync(video_path, duration)
    })
    .await
    .map_err(|e| e.to_string())?
}

// -------------------------------------------------------------
// METRICAS E ESTATISTICAS
// -------------------------------------------------------------
#[tauri::command]
fn get_project_stats(project_id: String) -> Result<ProjectStats, String> {
    let details = load_project_details(&project_id)?;
    let result = load_project_videos_internal(&details)?;

    let total_videos = result.videos.len();
    let total_size_bytes: u64 = result.videos.iter().map(|v| v.size_bytes).sum();
    let total_duration_secs: u64 = result.videos.iter().map(|v| v.duration_secs).sum();
    let total_favorites = details.favorites.len();

    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    for tags in details.tags.values() {
        for tag in tags {
            *tag_counts.entry(tag.clone()).or_insert(0) += 1;
        }
    }
    let mut top_tags: Vec<(String, usize)> = tag_counts.into_iter().collect();
    top_tags.sort_by(|a, b| b.1.cmp(&a.1));
    top_tags.truncate(8);

    let mut folder_counts: HashMap<String, usize> = HashMap::new();
    for v in &result.videos {
        *folder_counts.entry(v.folder_origin.clone()).or_insert(0) += 1;
    }
    let mut folders_summary: Vec<(String, usize)> = folder_counts.into_iter().collect();
    folders_summary.sort_by(|a, b| b.1.cmp(&a.1));

    let total_plays: u64 = details.play_counts.values().sum();

    Ok(ProjectStats {
        total_videos,
        total_size_bytes,
        total_duration_secs,
        total_favorites,
        total_plays,
        top_tags,
        folders_summary,
    })
}

// -------------------------------------------------------------
// OPERAÇÕES EM LOTE (BATCH ACTIONS)
// -------------------------------------------------------------
#[tauri::command]
fn batch_toggle_favorite(
    project_id: String,
    video_paths: Vec<String>,
    favorite: bool,
) -> Result<(), String> {
    let mut details = load_project_details(&project_id)?;
    for path in video_paths {
        if favorite {
            details.favorites.insert(path);
        } else {
            details.favorites.remove(&path);
        }
    }
    save_project_details(&details)?;
    Ok(())
}

#[tauri::command]
fn batch_add_tags(
    project_id: String,
    video_paths: Vec<String>,
    tags_to_add: Vec<String>,
) -> Result<(), String> {
    let mut details = load_project_details(&project_id)?;

    for tag in &tags_to_add {
        if !details.available_tags.contains(tag) {
            details.available_tags.push(tag.clone());
        }
    }

    for path in video_paths {
        let entry = details.tags.entry(path).or_default();
        for tag in &tags_to_add {
            if !entry.contains(tag) {
                entry.push(tag.clone());
            }
        }
    }

    save_project_details(&details)?;
    Ok(())
}

#[tauri::command]
fn batch_remove_tags(
    project_id: String,
    video_paths: Vec<String>,
    tags_to_remove: Vec<String>,
) -> Result<(), String> {
    let mut details = load_project_details(&project_id)?;

    for path in video_paths {
        if let Some(entry) = details.tags.get_mut(&path) {
            entry.retain(|t| !tags_to_remove.contains(t));
        }
    }

    save_project_details(&details)?;
    Ok(())
}

#[tauri::command]
fn toggle_favorite(project_id: String, video_path: String) -> Result<bool, String> {
    let mut details = load_project_details(&project_id)?;

    let is_fav = if details.favorites.contains(&video_path) {
        details.favorites.remove(&video_path);
        false
    } else {
        details.favorites.insert(video_path);
        true
    };

    save_project_details(&details)?;
    Ok(is_fav)
}

#[tauri::command]
fn set_video_tags(project_id: String, video_path: String, tags: Vec<String>) -> Result<(), String> {
    let mut details = load_project_details(&project_id)?;

    for tag in &tags {
        if !details.available_tags.contains(tag) {
            details.available_tags.push(tag.clone());
        }
    }

    details.tags.insert(video_path, tags);
    save_project_details(&details)?;
    Ok(())
}

#[tauri::command]
fn open_in_player(
    app: tauri::AppHandle,
    video_path: String,
    preferred_player: Option<String>,
    single_instance: Option<bool>,
) -> Result<(), String> {
    let pref = preferred_player.unwrap_or_else(|| "vlc".to_string()).to_lowercase();
    let reuse = single_instance.unwrap_or(true);

    if pref != "system" {
        let candidate_paths: &[&str] = match pref.as_str() {
            "vlc" => &[
                r"C:\Program Files\VideoLAN\VLC\vlc.exe",
                r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
            ],
            "mpv" => &[
                r"C:\Program Files\mpv\mpv.exe",
                r"C:\Program Files (x86)\mpv\mpv.exe",
                r"C:\tools\mpv\mpv.exe",
            ],
            "mpc" => &[
                r"C:\Program Files\MPC-HC\mpc-hc64.exe",
                r"C:\Program Files (x86)\MPC-HC\mpc-hc.exe",
                r"C:\Program Files\K-Lite Codec Pack\MPC-HC64\mpc-hc64.exe",
            ],
            "wmplayer" => &[
                r"C:\Program Files\Windows Media Player\wmplayer.exe",
                r"C:\Program Files (x86)\Windows Media Player\wmplayer.exe",
            ],
            _ => &[],
        };

        let mut player_args: Vec<&str> = Vec::new();
        if pref == "vlc" {
            if reuse {
                player_args.push("--one-instance");
                player_args.push("--no-playlist-enqueue");
            } else {
                player_args.push("--no-one-instance");
            }
        } else if pref == "mpc" {
            if reuse {
                player_args.push("/play");
            }
        }

        for player_path in candidate_paths {
            if Path::new(player_path).exists() {
                let mut cmd = Command::new(player_path);
                for arg in &player_args {
                    cmd.arg(arg);
                }
                cmd.arg(&video_path);
                cmd.creation_flags(CREATE_NO_WINDOW);
                let res = cmd.spawn();
                if res.is_ok() {
                    return Ok(());
                }
            }
        }

        // Tenta também pelo PATH do sistema caso o executável esteja no PATH
        let exe_name = match pref.as_str() {
            "vlc" => "vlc",
            "mpv" => "mpv",
            "mpc" => "mpc-hc64",
            "wmplayer" => "wmplayer",
            _ => "",
        };
        if !exe_name.is_empty() {
            let mut cmd = Command::new(exe_name);
            for arg in &player_args {
                cmd.arg(arg);
            }
            cmd.arg(&video_path);
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Ok(_) = cmd.spawn() {
                return Ok(());
            }
        }
    }

    // Abertura nativa segura via plugin opener do Tauri
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_path(&video_path, None::<&str>);
    Ok(())
}

#[tauri::command]
fn open_in_explorer(video_path: String) -> Result<(), String> {
    // Sanitização para prevenir injeção de argumentos via aspas no explorer
    let win_path = video_path.replace('"', "").replace('/', "\\");
    let path = Path::new(&win_path);
    if path.exists() {
        let mut cmd = Command::new("explorer");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(format!("/select,\"{}\"", win_path));
        }
        #[cfg(not(target_os = "windows"))]
        {
            cmd.arg(&win_path);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    } else if let Some(parent) = path.parent() {
        Command::new("explorer")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        return Err("Arquivo não encontrado".to_string());
    }
    Ok(())
}

#[tauri::command]
fn clear_thumbnail_cache() -> Result<usize, String> {
    let thumbs_dir = get_app_storage_dir().join("thumbnails");
    let mut deleted_count = 0;
    if let Ok(entries) = fs::read_dir(thumbs_dir) {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    if fs::remove_file(entry.path()).is_ok() {
                        deleted_count += 1;
                    }
                }
            }
        }
    }
    Ok(deleted_count)
}

// -------------------------------------------------------------
// LOCALIZADOR DE VÍDEOS DUPLICADOS
// -------------------------------------------------------------
fn compute_quick_file_hash(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let len = meta.len();
    let mut hasher = Sha256::new();
    hasher.update(&len.to_le_bytes());

    let chunk_size = 64 * 1024; // 64 KB
    let mut buf = vec![0u8; chunk_size];

    // Lê os primeiros 64KB
    let n1 = file.read(&mut buf).ok()?;
    hasher.update(&buf[..n1]);

    // Lê os últimos 64KB se o arquivo for maior
    if len > (chunk_size as u64) {
        let seek_pos = len.saturating_sub(chunk_size as u64);
        if file.seek(SeekFrom::Start(seek_pos)).is_ok() {
            let n2 = file.read(&mut buf).ok()?;
            hasher.update(&buf[..n2]);
        }
    }

    let result = hasher.finalize();
    Some(result.iter().map(|b| format!("{:02x}", b)).collect())
}

#[tauri::command]
fn find_project_duplicates(
    project_id: String,
    criteria: String,
) -> Result<Vec<DuplicateGroup>, String> {
    let details = load_project_details(&project_id)?;
    let result = load_project_videos_internal(&details)?;

    let mut groups_map: HashMap<String, Vec<VideoItem>> = HashMap::new();

    match criteria.as_str() {
        "size_name" => {
            for v in result.videos {
                let key = format!("{}_{}", v.size_bytes, v.name.to_lowercase());
                groups_map.entry(key).or_default().push(v);
            }
        }
        "size_duration" => {
            for v in result.videos {
                if v.size_bytes > 0 && v.duration_secs > 0 {
                    let key = format!("{}_{}", v.size_bytes, v.duration_secs);
                    groups_map.entry(key).or_default().push(v);
                }
            }
        }
        _ => {
            // "content" ou padrão (hash parcial de conteúdo):
            let mut size_buckets: HashMap<u64, Vec<VideoItem>> = HashMap::new();
            for v in result.videos {
                if v.size_bytes > 0 {
                    size_buckets.entry(v.size_bytes).or_default().push(v);
                }
            }

            for (size, list) in size_buckets {
                if list.len() > 1 {
                    for v in list {
                        let path = Path::new(&v.path);
                        if let Some(hash) = compute_quick_file_hash(path) {
                            let key = format!("{}_{}", size, hash);
                            groups_map.entry(key).or_default().push(v);
                        } else {
                            let key = format!("{}_{}", size, v.name.to_lowercase());
                            groups_map.entry(key).or_default().push(v);
                        }
                    }
                }
            }
        }
    }

    let mut duplicate_groups: Vec<DuplicateGroup> = groups_map
        .into_iter()
        .filter(|(_, items)| items.len() > 1)
        .map(|(key, items)| {
            let total_size_bytes = items.iter().map(|i| i.size_bytes).sum();
            DuplicateGroup {
                key,
                match_type: criteria.clone(),
                total_size_bytes,
                items,
            }
        })
        .collect();

    // Ordena pelo maior volume de espaço total desperdiçado
    duplicate_groups.sort_by(|a, b| b.total_size_bytes.cmp(&a.total_size_bytes));

    Ok(duplicate_groups)
}

// -------------------------------------------------------------
// MOVER OU COPIAR ARQUIVOS ENTRE PASTAS
// -------------------------------------------------------------
#[tauri::command]
fn move_or_copy_videos(
    project_id: String,
    video_paths: Vec<String>,
    dest_folder: String,
    is_move: bool,
) -> Result<FileOperationResult, String> {
    let dest_dir = Path::new(&dest_folder);
    if !dest_dir.is_dir() {
        return Err(format!("A pasta de destino não existe: {}", dest_folder));
    }

    let _guard = PROJECT_MUTEX.lock().unwrap();
    let mut details = load_project_details(&project_id)?;
    let thumbs_dir = get_app_storage_dir().join("thumbnails");

    let mut success_paths = Vec::new();
    let mut failed_paths = Vec::new();

    for src_path_str in video_paths {
        let src_path = Path::new(&src_path_str);
        if !src_path.exists() {
            failed_paths.push((src_path_str, "Arquivo de origem não encontrado".into()));
            continue;
        }

        let file_name = match src_path.file_name() {
            Some(name) => name,
            None => {
                failed_paths.push((src_path_str, "Nome de arquivo inválido".into()));
                continue;
            }
        };

        // Tratamento de colisão: se já existir arquivo no destino com mesmo nome, adiciona sufixo (1), (2)...
        let mut dest_path = dest_dir.join(file_name);
        if dest_path.exists() && dest_path != src_path {
            let stem = src_path.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
            let ext = src_path.extension().and_then(|s| s.to_str()).unwrap_or("");
            let mut counter = 1;
            loop {
                let candidate_name = if ext.is_empty() {
                    format!("{} ({})", stem, counter)
                } else {
                    format!("{} ({}).{}", stem, counter, ext)
                };
                let candidate_path = dest_dir.join(&candidate_name);
                if !candidate_path.exists() {
                    dest_path = candidate_path;
                    break;
                }
                counter += 1;
            }
        }

        let dest_path_str = dest_path.to_string_lossy().to_string();

        if is_move {
            if dest_path == src_path {
                success_paths.push(dest_path_str);
                continue;
            }

            let move_res = fs::rename(&src_path, &dest_path).or_else(|_| {
                // Fallback para movimentação entre partições/discos diferentes (copia e depois remove origem)
                fs::copy(&src_path, &dest_path).and_then(|_| fs::remove_file(&src_path).map(|_| ()))
            });

            match move_res {
                Ok(_) => {
                    success_paths.push(dest_path_str.clone());

                    // Migra metadados no projeto
                    if details.favorites.remove(&src_path_str) {
                        details.favorites.insert(dest_path_str.clone());
                    }
                    if let Some(tags) = details.tags.remove(&src_path_str) {
                        details.tags.insert(dest_path_str.clone(), tags);
                    }
                    if let Some(dur) = details.durations.remove(&src_path_str) {
                        details.durations.insert(dest_path_str.clone(), dur);
                    }
                    if let Some(cnt) = details.play_counts.remove(&src_path_str) {
                        details.play_counts.insert(dest_path_str.clone(), cnt);
                    }
                    if let Some(lp) = details.last_played.remove(&src_path_str) {
                        details.last_played.insert(dest_path_str.clone(), lp);
                    }

                    for file in &mut details.individual_files {
                        if *file == src_path_str {
                            *file = dest_path_str.clone();
                        }
                    }

                    // Migra miniaturas
                    let old_hash = hash_path(&src_path_str);
                    let new_hash = hash_path(&dest_path_str);
                    if old_hash != new_hash {
                        let old_thumb = thumbs_dir.join(format!("{}.webp", old_hash));
                        let new_thumb = thumbs_dir.join(format!("{}.webp", new_hash));
                        if old_thumb.exists() {
                            let _ = fs::copy(&old_thumb, &new_thumb);
                            let _ = fs::remove_file(&old_thumb);
                        }
                        let old_scrub = thumbs_dir.join(format!("{}_scrub.webp", old_hash));
                        let new_scrub = thumbs_dir.join(format!("{}_scrub.webp", new_hash));
                        if old_scrub.exists() {
                            let _ = fs::copy(&old_scrub, &new_scrub);
                            let _ = fs::remove_file(&old_scrub);
                        }
                    }
                }
                Err(e) => {
                    failed_paths.push((src_path_str, e.to_string()));
                }
            }
        } else {
            // Copiar arquivo
            match fs::copy(&src_path, &dest_path) {
                Ok(_) => {
                    success_paths.push(dest_path_str.clone());

                    // Clona metadados para o novo arquivo copiado
                    if let Some(tags) = details.tags.get(&src_path_str).cloned() {
                        details.tags.insert(dest_path_str.clone(), tags);
                    }
                    if let Some(dur) = details.durations.get(&src_path_str).copied() {
                        details.durations.insert(dest_path_str.clone(), dur);
                    }
                }
                Err(e) => {
                    failed_paths.push((src_path_str, e.to_string()));
                }
            }
        }
    }

    let _ = save_project_details(&details);

    Ok(FileOperationResult {
        success_paths,
        failed_paths,
    })
}

// -------------------------------------------------------------
// MOVER PARA A LIXEIRA DO WINDOWS
// -------------------------------------------------------------
#[tauri::command]
fn move_videos_to_trash(
    project_id: String,
    video_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let _guard = PROJECT_MUTEX.lock().unwrap();
    let mut details = load_project_details(&project_id)?;
    let mut deleted_paths = Vec::new();
    let mut errors = Vec::new();

    for path_str in &video_paths {
        let p = Path::new(path_str);
        if p.exists() {
            match trash::delete(p) {
                Ok(_) => {
                    deleted_paths.push(path_str.clone());
                    details.favorites.remove(path_str);
                    details.tags.remove(path_str);
                    details.durations.remove(path_str);
                    details.play_counts.remove(path_str);
                    details.last_played.remove(path_str);
                    details.individual_files.retain(|f| f != path_str);
                }
                Err(e) => {
                    errors.push(format!("{}: {}", path_str, e));
                }
            }
        } else {
            deleted_paths.push(path_str.clone());
            details.favorites.remove(path_str);
            details.tags.remove(path_str);
            details.durations.remove(path_str);
            details.play_counts.remove(path_str);
            details.last_played.remove(path_str);
            details.individual_files.retain(|f| f != path_str);
        }
    }

    let _ = save_project_details(&details);

    if !errors.is_empty() && deleted_paths.is_empty() {
        return Err(format!("Erro ao mover para a Lixeira: {}", errors.join("; ")));
    }

    Ok(deleted_paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            delete_project,
            rename_project,
            update_project_settings,
            add_folder_to_project,
            add_folders_to_project,
            remove_folder_from_project,
            remove_folders_from_project,
            add_project_tag,
            remove_project_tag,
            add_dropped_paths,
            add_individual_files,
            remove_individual_file,
            toggle_subfolders,
            load_project_videos,
            set_project_password,
            verify_project_password,
            rename_video_file,
            record_video_play,
            sync_project,
            generate_single_thumbnail,
            save_project_durations,
            generate_hover_scrub,
            clear_thumbnail_cache,
            get_project_stats,
            batch_toggle_favorite,
            batch_add_tags,
            batch_remove_tags,
            toggle_favorite,
            set_video_tags,
            open_in_player,
            open_in_explorer,
            find_project_duplicates,
            move_or_copy_videos,
            move_videos_to_trash
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
