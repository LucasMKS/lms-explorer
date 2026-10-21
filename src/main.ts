import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

interface VideoItem {
  id: string;
  name: string;
  path: string;
  folder_origin: string;
  size_bytes: number;
  modified: number;
  duration_secs: u64;
  duration_probed?: boolean;
  thumbnail: string | null;
  scrub_sprite: string | null;
  is_favorite: boolean;
  tags: string[];
  play_count?: number;
  last_played?: number | null;
}

interface VideoPlayInfo {
  play_count: number;
  last_played: number;
}

type u64 = number;

interface ProjectSummary {
  id: string;
  name: string;
  folders_count: number;
  files_count?: number;
  created_at: number;
  is_locked?: boolean;
}

interface ProjectViewResult {
  project_id: string;
  project_name: string;
  folders: string[];
  individual_files?: string[];
  include_subfolders: boolean;
  videos: VideoItem[];
  available_tags: string[];
  sort_mode?: string | null;
  grid_size?: string | null;
  view_mode?: string | null;
  group_by?: string | null;
  is_locked?: boolean;
}

interface SyncReport {
  added_count: number;
  removed_count: number;
  total_count: number;
}

interface ProjectStats {
  total_videos: number;
  total_size_bytes: number;
  total_duration_secs: number;
  total_favorites: number;
  total_plays?: number;
  top_tags: [string, number][];
  folders_summary: [string, number][];
}

interface ThumbGenResult {
  thumbnail: string;
  scrub_sprite: string | null;
  duration_secs: number;
}

interface DuplicateGroup {
  key: string;
  match_type: string;
  total_size_bytes: number;
  items: VideoItem[];
}

interface FileOperationResult {
  success_paths: string[];
  failed_paths: [string, string][];
}

// Notion Tag Color Palette
const NOTION_COLOR_CLASSES = [
  "tag-color-blue",
  "tag-color-green",
  "tag-color-orange",
  "tag-color-purple",
  "tag-color-pink",
  "tag-color-yellow",
  "tag-color-red",
  "tag-color-brown",
  "tag-color-gray",
];

function getTagColorClass(tagName: string): string {
  let hash = 0;
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % NOTION_COLOR_CLASSES.length;
  return NOTION_COLOR_CLASSES[index];
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0) return "--:--";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const pad = (n: number) => n.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatDurationLong(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// ============================================================
// DIÁLOGO PERSONALIZADO (CONFIRM / ALERT NO ESTILO DO APP)
// ============================================================
interface DialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  type?: "danger" | "warning" | "info";
}

let dialogResolveCallback: ((value: boolean) => void) | null = null;

function showConfirmDialog(options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    dialogResolveCallback = resolve;
    const modal = document.getElementById("app-dialog-modal");
    const titleEl = document.getElementById("dialog-title");
    const msgEl = document.getElementById("dialog-message");
    const btnConfirm = document.getElementById("dialog-btn-confirm") as HTMLButtonElement | null;
    const btnCancel = document.getElementById("dialog-btn-cancel") as HTMLButtonElement | null;
    const iconBadge = document.getElementById("dialog-icon-badge");

    if (titleEl) titleEl.textContent = options.title || "Confirmar Ação";
    if (msgEl) msgEl.textContent = options.message;

    if (btnCancel) {
      btnCancel.classList.remove("hidden");
      btnCancel.textContent = options.cancelText || "Cancelar";
    }

    if (btnConfirm) {
      btnConfirm.textContent = options.confirmText || "Confirmar";
      btnConfirm.className = options.danger !== false ? "app-pill-btn danger" : "app-pill-btn primary-glow";
    }

    if (iconBadge) {
      iconBadge.className = `dialog-icon-badge ${options.type || (options.danger !== false ? "danger" : "info")}`;
    }

    modal?.classList.remove("hidden");
  });
}

function showAlertDialog(message: string, title: string = "Aviso"): Promise<void> {
  return new Promise((resolve) => {
    dialogResolveCallback = () => resolve();
    const modal = document.getElementById("app-dialog-modal");
    const titleEl = document.getElementById("dialog-title");
    const msgEl = document.getElementById("dialog-message");
    const btnConfirm = document.getElementById("dialog-btn-confirm") as HTMLButtonElement | null;
    const btnCancel = document.getElementById("dialog-btn-cancel") as HTMLButtonElement | null;
    const iconBadge = document.getElementById("dialog-icon-badge");

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;

    if (btnCancel) btnCancel.classList.add("hidden");
    if (btnConfirm) {
      btnConfirm.textContent = "OK";
      btnConfirm.className = "app-pill-btn primary-glow";
    }

    if (iconBadge) {
      iconBadge.className = "dialog-icon-badge info";
    }

    modal?.classList.remove("hidden");
  });
}

function closeAppDialog(result: boolean) {
  const modal = document.getElementById("app-dialog-modal");
  modal?.classList.add("hidden");
  if (dialogResolveCallback) {
    dialogResolveCallback(result);
    dialogResolveCallback = null;
  }
}

// ============================================================
// ESTADO GLOBAL DA APLICAÇÃO
// ============================================================
let allProjects: ProjectSummary[] = [];
let currentProjectId: string | null = null;
let currentProjectName: string = "";
let currentProjectFolders: string[] = [];
let currentProjectFiles: string[] = [];
let currentIncludeSubfolders: boolean = true;

let allVideos: VideoItem[] = [];
let availableProjectTags: string[] = [];
let selectedFilterTags: Set<string> = new Set();
let excludedFilterTags: Set<string> = new Set();
let filterOnlyFavorites: boolean = false;
let filterOnlyUntagged: boolean = false;
let filterSelectedSource: string | null = null;
let searchQuery: string = "";

let moveCopyTargetPaths: string[] = [];
let moveCopyIsMove: boolean = true;
let moveCopySelectedFolder: string | null = null;

// Ordenação, Visualização e Agrupamento
type SortMode =
  | "name-asc"
  | "name-desc"
  | "date-desc"
  | "date-asc"
  | "size-desc"
  | "size-asc"
  | "duration-desc"
  | "duration-asc"
  | "plays-desc"
  | "plays-asc"
  | "recent-played";

type ViewMode = "grid" | "table";
type GroupByMode = "none" | "folder" | "tag" | "date" | "format" | "status";

let currentSortMode: SortMode = (localStorage.getItem("lms_sort_mode") as SortMode) || "name-asc";
let currentGridSize: "small" | "medium" | "large" =
  (localStorage.getItem("lms_grid_size") as "small" | "medium" | "large") || "medium";
let currentViewMode: ViewMode = (localStorage.getItem("lms_view_mode") as ViewMode) || "grid";
let currentGroupBy: GroupByMode = (localStorage.getItem("lms_group_by") as GroupByMode) || "none";
let collapsedGroupIds: Set<string> = new Set();

// Seleção em Lote & Navegação Desktop
let selectedVideoIds: Set<string> = new Set();
let lastSelectedVideoId: string | null = null;
let activeInlineRenameVideoId: string | null = null;

// Fila de Thumbnails Otimizada (Concorrente & Cancelável)
let thumbQueueSessionId = 0;
let isQueueRunning = false;
let isQueuePaused = false;

// Configurações do Aplicativo
let hoverScrubbingEnabled: boolean = localStorage.getItem("lms_hover_scrub") !== "false";
let preferredPlayer: string = localStorage.getItem("lms_preferred_player") || "vlc";
let concurrencySetting: number = parseInt(localStorage.getItem("lms_concurrency") || "3", 10);

// Estado dos Menus e Modais
let contextTargetVideo: VideoItem | null = null;
let activeModalVideo: VideoItem | null = null;
let modalSelectedTags: Set<string> = new Set();

// Sorteio
type FavFilterMode = "any" | "only_fav" | "not_fav";
let randomFavMode: FavFilterMode = "any";
let randomTitleFilter: string = "";
let randomIncludeTags: Set<string> = new Set();
let randomExcludeTags: Set<string> = new Set();

// Lote Tags Modal Mode
let batchTagMode: "add" | "remove" = "add";

// Proteção por Senha
let currentProjectIsLocked: boolean = false;
const unlockedProjects: Set<string> = new Set();
let pendingUnlockProjectId: string | null = null;

// ============================================================
// ELEMENTOS DO DOM
// ============================================================
// Topbar
const btnProjectDropdown = document.getElementById("btn-project-dropdown") as HTMLButtonElement;
const currentProjectNameEl = document.getElementById("current-project-name") as HTMLElement;
const btnRenameCurrentProject = document.getElementById("btn-rename-current-project") as HTMLButtonElement | null;
const btnDropdownRenameProject = document.getElementById("btn-dropdown-rename-project") as HTMLButtonElement | null;
const btnDropdownPasswordProject = document.getElementById("btn-dropdown-password-project") as HTMLButtonElement | null;
const btnDropdownPasswordLabel = document.getElementById("btn-dropdown-password-label") as HTMLElement | null;
const projectDropdownMenu = document.getElementById("project-dropdown-menu") as HTMLDivElement;
const projectDropdownList = document.getElementById("project-dropdown-list") as HTMLDivElement;
const btnOpenCreateProjectModal = document.getElementById("btn-open-create-project-modal") as HTMLButtonElement;
const btnManageFolders = document.getElementById("btn-manage-folders") as HTMLButtonElement;
const foldersCountLabel = document.getElementById("folders-count-label") as HTMLElement;
const btnSyncProject = document.getElementById("btn-sync-project") as HTMLButtonElement | null;
const subviewBtnProjectPassword = document.getElementById("subview-btn-project-password") as HTMLButtonElement | null;
const subviewPasswordBtnLabel = document.getElementById("subview-password-btn-label") as HTMLElement | null;
const btnViewStats = document.getElementById("btn-view-stats") as HTMLButtonElement;
const statsBadge = document.getElementById("stats-badge") as HTMLElement;
const btnOpenRandomModal = document.getElementById("btn-open-random-modal") as HTMLButtonElement;

// Toolbar & Filtros
const appContentTopbar = document.getElementById("app-content-topbar") as HTMLElement | null;
const btnViewGrid = document.getElementById("btn-view-grid") as HTMLButtonElement | null;
const btnViewTable = document.getElementById("btn-view-table") as HTMLButtonElement | null;
const btnGroupDropdown = document.getElementById("btn-group-dropdown") as HTMLButtonElement | null;
const groupLabel = document.getElementById("group-label") as HTMLElement | null;
const groupDropdownMenu = document.getElementById("group-dropdown-menu") as HTMLDivElement | null;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const btnClearSearch = document.getElementById("btn-clear-search") as HTMLButtonElement;
const btnSortDropdown = document.getElementById("btn-sort-dropdown") as HTMLButtonElement | null;
const sortLabel = document.getElementById("sort-label") as HTMLElement | null;
const sortDropdownMenu = document.getElementById("sort-dropdown-menu") as HTMLDivElement | null;
const filterFavBtn = document.getElementById("filter-fav-btn") as HTMLButtonElement;
const tagFilterList = document.getElementById("tag-filter-list") as HTMLDivElement;
const btnSidebarAddTag = document.getElementById("btn-sidebar-add-tag") as HTMLButtonElement | null;
const sidebarNewTagWrap = document.getElementById("sidebar-new-tag-wrap") as HTMLDivElement | null;
const sidebarNewTagInput = document.getElementById("sidebar-new-tag-input") as HTMLInputElement | null;
const sidebarNewTagClose = document.getElementById("sidebar-new-tag-close") as HTMLButtonElement | null;

// Zoom
const zoomBtns = document.querySelectorAll(".zoom-btn");

// Viewport Principal
const mainScrollViewport = document.getElementById("main-scroll-container") as HTMLElement;
const emptyStateNoProject = document.getElementById("empty-state-no-project") as HTMLDivElement;
const emptyStateNoFolders = document.getElementById("empty-state-no-folders") as HTMLDivElement;
const btnCreateFirstProject = document.getElementById("btn-create-first-project") as HTMLButtonElement;
const btnAddFolderEmpty = document.getElementById("btn-add-folder-empty") as HTMLButtonElement;
const videoGrid = document.getElementById("video-grid") as HTMLDivElement;
const noResults = document.getElementById("no-results") as HTMLDivElement;

// Barra Flutuante de Seleção em Lote
const batchActionBar = document.getElementById("batch-action-bar") as HTMLDivElement;
const batchSelectedCount = document.getElementById("batch-selected-count") as HTMLElement;
const btnBatchFavorite = document.getElementById("btn-batch-favorite") as HTMLButtonElement;
const btnBatchAddTags = document.getElementById("btn-batch-add-tags") as HTMLButtonElement;
const btnBatchRemoveTags = document.getElementById("btn-batch-remove-tags") as HTMLButtonElement;
const btnBatchMove = document.getElementById("btn-batch-move") as HTMLButtonElement | null;
const btnBatchCopy = document.getElementById("btn-batch-copy") as HTMLButtonElement | null;
const btnBatchTrash = document.getElementById("btn-batch-trash") as HTMLButtonElement | null;
const btnBatchClear = document.getElementById("btn-batch-clear") as HTMLButtonElement;

// Progress de Thumbs com Controles
const thumbProgressContainer = document.getElementById("thumb-progress-container") as HTMLDivElement;
const thumbProgressTitle = document.getElementById("thumb-progress-title") as HTMLElement;
const thumbProgressCount = document.getElementById("thumb-progress-count") as HTMLElement;
const thumbProgressFill = document.getElementById("thumb-progress-fill") as HTMLDivElement;
const btnPauseThumbs = document.getElementById("btn-pause-thumbs") as HTMLButtonElement;
const btnResumeThumbs = document.getElementById("btn-resume-thumbs") as HTMLButtonElement;
const btnCancelThumbs = document.getElementById("btn-cancel-thumbs") as HTMLButtonElement;

// Menus de Contexto
const contextMenu = document.getElementById("context-menu") as HTMLDivElement;
const viewContextMenu = document.getElementById("view-context-menu") as HTMLDivElement | null;
const ctxPlay = document.getElementById("ctx-play") as HTMLDivElement;
const ctxFav = document.getElementById("ctx-fav") as HTMLDivElement;
const ctxFavIcon = document.getElementById("ctx-fav-icon") as HTMLElement;
const ctxFavLabel = document.getElementById("ctx-fav-label") as HTMLElement;
const ctxTagsSubmenuList = document.getElementById("ctx-tags-submenu-list") as HTMLDivElement | null;
const ctxQuickTagInput = document.getElementById("ctx-quick-tag-input") as HTMLInputElement | null;
const ctxTagsOpenModal = document.getElementById("ctx-tags-open-modal") as HTMLDivElement | null;
const ctxExplorer = document.getElementById("ctx-explorer") as HTMLDivElement;
const ctxCopyPath = document.getElementById("ctx-copy-path") as HTMLDivElement;
const ctxMoveFile = document.getElementById("ctx-move-file") as HTMLDivElement | null;
const ctxCopyFile = document.getElementById("ctx-copy-file") as HTMLDivElement | null;
const ctxTrashFile = document.getElementById("ctx-trash-file") as HTMLDivElement | null;
const ctxRemoveFile = document.getElementById("ctx-remove-file") as HTMLDivElement | null;
const dragDropOverlay = document.getElementById("drag-drop-overlay") as HTMLDivElement | null;

// Modal de Diálogo Customizado (Confirm / Alert)
const appDialogModal = document.getElementById("app-dialog-modal") as HTMLDivElement | null;
const btnDialogConfirm = document.getElementById("dialog-btn-confirm") as HTMLButtonElement | null;
const btnDialogCancel = document.getElementById("dialog-btn-cancel") as HTMLButtonElement | null;

// Renomear Vídeo
const ctxRenameVideo = document.getElementById("ctx-rename-video") as HTMLDivElement | null;
const renameVideoModal = document.getElementById("rename-video-modal") as HTMLDivElement | null;
const renameVideoInput = document.getElementById("rename-video-input") as HTMLInputElement | null;
const renameVideoConfirmBtn = document.getElementById("rename-video-confirm-btn") as HTMLButtonElement | null;
const renameVideoCancelBtn = document.getElementById("rename-video-cancel-btn") as HTMLButtonElement | null;

// Modal de Desbloqueio de Senha do Projeto
const projectPasswordModal = document.getElementById("project-password-modal") as HTMLDivElement | null;
const projectPasswordInput = document.getElementById("project-password-input") as HTMLInputElement | null;
const projectPasswordError = document.getElementById("project-password-error") as HTMLDivElement | null;
const projectPasswordConfirmBtn = document.getElementById("project-password-confirm-btn") as HTMLButtonElement | null;
const projectPasswordCancelBtn = document.getElementById("project-password-cancel-btn") as HTMLButtonElement | null;

// Modal de Gerenciamento de Senha do Projeto
const projectManagePasswordModal = document.getElementById("project-manage-password-modal") as HTMLDivElement | null;
const managePasswordTitle = document.getElementById("manage-password-title") as HTMLElement | null;
const managePasswordCurrentGroup = document.getElementById("manage-password-current-group") as HTMLDivElement | null;
const managePasswordCurrentInput = document.getElementById("manage-password-current-input") as HTMLInputElement | null;
const managePasswordNewInput = document.getElementById("manage-password-new-input") as HTMLInputElement | null;
const managePasswordError = document.getElementById("manage-password-error") as HTMLDivElement | null;
const managePasswordSaveBtn = document.getElementById("manage-password-save-btn") as HTMLButtonElement | null;
const managePasswordCancelBtn = document.getElementById("manage-password-cancel-btn") as HTMLButtonElement | null;

// Modais & QuickPick Estilo VS Code
const quickpickBar = document.getElementById("quickpick-bar") as HTMLDivElement | null;
const quickpickInput = document.getElementById("quickpick-input") as HTMLInputElement | null;
const quickpickSubmitBtn = document.getElementById("quickpick-submit-btn") as HTMLButtonElement | null;
const quickpickCloseBtn = document.getElementById("quickpick-close-btn") as HTMLButtonElement | null;

// Sub-aplicativo Integrado (Workspace Subview)
const workspaceSubview = document.getElementById("workspace-subview") as HTMLDivElement;
const subviewBtnBack = document.getElementById("subview-btn-back") as HTMLButtonElement;
const subviewBreadcrumbParent = document.getElementById("subview-breadcrumb-parent") as HTMLSpanElement;
const subviewBreadcrumbCurrent = document.getElementById("subview-breadcrumb-current") as HTMLSpanElement;

// Subview Panes
const subviewPaneSources = document.getElementById("subview-pane-sources") as HTMLDivElement;
const subviewPaneSettings = document.getElementById("subview-pane-settings") as HTMLDivElement;
const subviewPaneStats = document.getElementById("subview-pane-stats") as HTMLDivElement;

// Sources Subview Elements
const subviewBtnAddFolder = document.getElementById("subview-btn-add-folder") as HTMLButtonElement;
const subviewBtnSync = document.getElementById("subview-btn-sync") as HTMLButtonElement;
const subviewSyncBtnLabel = document.getElementById("subview-sync-btn-label") as HTMLSpanElement;
const subviewBtnDeleteProject = document.getElementById("subview-btn-delete-project") as HTMLButtonElement;
const subviewSyncStatusBanner = document.getElementById("subview-sync-status-banner") as HTMLDivElement;
const subviewSyncStatusText = document.getElementById("subview-sync-status-text") as HTMLSpanElement;
const subviewFoldersCount = document.getElementById("subview-folders-count") as HTMLElement;
const subviewToggleSubfolders = document.getElementById("subview-toggle-subfolders") as HTMLInputElement;
const subviewFoldersList = document.getElementById("subview-folders-list") as HTMLDivElement;
const subviewFoldersSelectAllWrap = document.getElementById("subview-folders-select-all-wrap") as HTMLElement | null;
const subviewFoldersSelectAll = document.getElementById("subview-folders-select-all") as HTMLInputElement | null;
const subviewBtnBatchRemoveFolders = document.getElementById("subview-btn-batch-remove-folders") as HTMLButtonElement | null;
const subviewBatchRemoveFoldersLabel = document.getElementById("subview-batch-remove-folders-label") as HTMLSpanElement | null;
let selectedFolderPaths: Set<string> = new Set();
const subviewLooseCountBadge = document.getElementById("subview-loose-count-badge") as HTMLElement;
const subviewBtnAddLooseFiles = document.getElementById("subview-btn-add-loose-files") as HTMLButtonElement;
const btnAddFileEmpty = document.getElementById("btn-add-file-empty") as HTMLButtonElement | null;

// Stats Subview Elements
const subviewStatTotalVideos = document.getElementById("subview-stat-total-videos") as HTMLElement;
const subviewStatTotalSize = document.getElementById("subview-stat-total-size") as HTMLElement;
const subviewStatTotalDuration = document.getElementById("subview-stat-total-duration") as HTMLElement;
const subviewStatTotalFavs = document.getElementById("subview-stat-total-favs") as HTMLElement;
const subviewStatTotalPlays = document.getElementById("subview-stat-total-plays") as HTMLElement | null;
const subviewStatsTopTags = document.getElementById("subview-stats-top-tags") as HTMLDivElement;
const subviewStatsFoldersSummary = document.getElementById("subview-stats-folders-summary") as HTMLDivElement;

const batchTagsModal = document.getElementById("batch-tags-modal") as HTMLDivElement;
const btnCloseBatchTagsModal = document.getElementById("btn-close-batch-tags-modal") as HTMLButtonElement;
const batchTagsModalTitle = document.getElementById("batch-tags-modal-title") as HTMLElement;
const batchTagsModalDesc = document.getElementById("batch-tags-modal-desc") as HTMLElement;
const batchNewTagInputGroup = document.getElementById("batch-new-tag-input-group") as HTMLDivElement;
const batchTagInput = document.getElementById("batch-tag-input") as HTMLInputElement;
const batchModalTagsList = document.getElementById("batch-modal-tags-list") as HTMLDivElement;
const btnSubmitBatchTags = document.getElementById("btn-submit-batch-tags") as HTMLButtonElement;

const tagsModal = document.getElementById("tags-modal") as HTMLDivElement;
const btnCloseTagsModal = document.getElementById("btn-close-tags-modal") as HTMLButtonElement;
const modalVideoName = document.getElementById("modal-video-name") as HTMLElement;
const newTagInput = document.getElementById("new-tag-input") as HTMLInputElement;
const btnAddNewTag = document.getElementById("btn-add-new-tag") as HTMLButtonElement;
const modalTagsList = document.getElementById("modal-tags-list") as HTMLDivElement;
const btnSaveTags = document.getElementById("btn-save-tags") as HTMLButtonElement;

const randomModal = document.getElementById("random-modal") as HTMLDivElement;
const btnCloseRandomModal = document.getElementById("btn-close-random-modal") as HTMLButtonElement;
const randomFavControl = document.getElementById("random-fav-control") as HTMLDivElement;
const randomIncludeTagsContainer = document.getElementById("random-include-tags") as HTMLDivElement;
const randomExcludeTagsContainer = document.getElementById("random-exclude-tags") as HTMLDivElement;
const randomMatchingCount = document.getElementById("random-matching-count") as HTMLElement;
const randomTitleInput = document.getElementById("random-title-input") as HTMLInputElement | null;
const btnExecuteRandomPlay = document.getElementById("btn-execute-random-play") as HTMLButtonElement;

// Duplicados Modal
const duplicatesModal = document.getElementById("duplicates-modal") as HTMLDivElement | null;
const duplicatesModalClose = document.getElementById("duplicates-modal-close") as HTMLButtonElement | null;
const duplicatesCriteriaSelect = document.getElementById("duplicates-criteria-select") as HTMLSelectElement | null;
const btnScanDuplicates = document.getElementById("btn-scan-duplicates") as HTMLButtonElement | null;
const duplicatesSummaryBanner = document.getElementById("duplicates-summary-banner") as HTMLDivElement | null;
const duplicatesSummaryText = document.getElementById("duplicates-summary-text") as HTMLElement | null;
const duplicatesResultsContainer = document.getElementById("duplicates-results-container") as HTMLDivElement | null;
const duplicatesEmptyHint = document.getElementById("duplicates-empty-hint") as HTMLElement | null;
const duplicatesModalBtnDone = document.getElementById("duplicates-modal-btn-done") as HTMLButtonElement | null;

// Mover/Copiar Modal
const moveCopyModal = document.getElementById("move-copy-modal") as HTMLDivElement | null;
const moveCopyTitle = document.getElementById("move-copy-title") as HTMLElement | null;
const moveCopyDesc = document.getElementById("move-copy-desc") as HTMLElement | null;
const moveCopyFoldersList = document.getElementById("move-copy-folders-list") as HTMLDivElement | null;
const moveCopyBtnBrowse = document.getElementById("move-copy-btn-browse") as HTMLButtonElement | null;
const moveCopyDestLabel = document.getElementById("move-copy-dest-label") as HTMLElement | null;
const moveCopyBtnCancel = document.getElementById("move-copy-btn-cancel") as HTMLButtonElement | null;
const moveCopyBtnConfirm = document.getElementById("move-copy-btn-confirm") as HTMLButtonElement | null;

// Configurações & Menubar Clássico
const btnOpenSettings = document.getElementById("btn-open-settings") as HTMLButtonElement;
const menubarBtnSettings = document.getElementById("menubar-btn-settings") as HTMLButtonElement;
const subviewSettingHoverScrub = document.getElementById("subview-setting-hover-scrub") as HTMLInputElement;
const subviewSettingPlayer = document.getElementById("subview-setting-player") as HTMLSelectElement;
const subviewSettingConcurrency = document.getElementById("subview-setting-concurrency") as HTMLSelectElement;
const subviewBtnClearCache = document.getElementById("subview-btn-clear-cache") as HTMLButtonElement;
const menubarBtnAbout = document.getElementById("menubar-btn-about") as HTMLButtonElement;

const menubarBtns = document.querySelectorAll<HTMLButtonElement>(".menubar-btn[data-menu]");
const menubarDropdowns = document.querySelectorAll<HTMLDivElement>(".menubar-dropdown");
const menuActNewProject = document.getElementById("menu-act-new-project") as HTMLElement;
const menuActRenameProject = document.getElementById("menu-act-rename-project") as HTMLElement | null;
const menuActPasswordProject = document.getElementById("menu-act-password-project") as HTMLElement | null;
const menuActManageFolders = document.getElementById("menu-act-manage-folders") as HTMLElement;
const menuActAddFiles = document.getElementById("menu-act-add-files") as HTMLElement | null;
const menuActSync = document.getElementById("menu-act-sync") as HTMLElement;
const menuActSelectAll = document.getElementById("menu-act-select-all") as HTMLElement;
const menuActClearSelect = document.getElementById("menu-act-clear-select") as HTMLElement;
const menuActDuplicates = document.getElementById("menu-act-duplicates") as HTMLElement | null;
const menuActRandom = document.getElementById("menu-act-random") as HTMLElement;
const menuActStats = document.getElementById("menu-act-stats") as HTMLElement;
const menuActDeleteProject = document.getElementById("menu-act-delete-project") as HTMLElement | null;
const menuZoomActions = document.querySelectorAll<HTMLElement>("[data-set-zoom]");

// Elementos da Barra Lateral & Status Bar
const btnToggleSidebar = document.getElementById("btn-toggle-sidebar") as HTMLButtonElement | null;
const appSidebar = document.getElementById("app-sidebar") as HTMLElement | null;
const navAllVideos = document.getElementById("nav-all-videos") as HTMLButtonElement | null;
const navUntaggedVideos = document.getElementById("nav-untagged-videos") as HTMLButtonElement | null;
const sidebarCountAll = document.getElementById("sidebar-count-all") as HTMLElement | null;
const sidebarCountFavs = document.getElementById("sidebar-count-favs") as HTMLElement | null;
const sidebarCountUntagged = document.getElementById("sidebar-count-untagged") as HTMLElement | null;
const sidebarFoldersList = document.getElementById("sidebar-folders-list") as HTMLDivElement | null;
const currentViewTitle = document.getElementById("current-view-title") as HTMLElement | null;
const currentViewCounter = document.getElementById("current-view-counter") as HTMLElement | null;
const statusbarProjectLabel = document.getElementById("statusbar-project-label") as HTMLElement | null;
const statusbarSyncLabel = document.getElementById("statusbar-sync-label") as HTMLElement | null;
const statusbarItemsSummary = document.getElementById("statusbar-items-summary") as HTMLElement | null;
const statusbarStorageSummary = document.getElementById("statusbar-storage-summary") as HTMLElement | null;

// ============================================================
// CARREGAMENTO DE PROJETOS & PASTAS
// ============================================================
async function refreshProjectsList() {
  try {
    allProjects = await invoke<ProjectSummary[]>("list_projects");
    renderProjectDropdown();

    if (allProjects.length === 0) {
      currentProjectId = null;
      showNoProjectState();
      return;
    }

    const savedId = localStorage.getItem("lms_active_project_id");
    const exists = allProjects.find((p) => p.id === savedId);

    if (exists) {
      if (exists.is_locked && !unlockedProjects.has(exists.id)) {
        openUnlockPasswordModal(exists.id);
      } else {
        await switchProject(exists.id);
      }
    } else {
      const first = allProjects[0];
      if (first.is_locked && !unlockedProjects.has(first.id)) {
        openUnlockPasswordModal(first.id);
      } else {
        await switchProject(first.id);
      }
    }
  } catch (err) {
    console.error("Erro ao listar projetos:", err);
  }
}

function renderProjectDropdown() {
  projectDropdownList.innerHTML = "";

  if (allProjects.length === 0) {
    const emptySpan = document.createElement("div");
    emptySpan.style.padding = "0.5rem 0.75rem";
    emptySpan.style.fontSize = "0.75rem";
    emptySpan.style.color = "var(--nt-text-muted)";
    emptySpan.textContent = "Nenhum projeto criado.";
    projectDropdownList.appendChild(emptySpan);
    return;
  }

  for (const proj of allProjects) {
    const item = document.createElement("div");
    item.className = `dropdown-item ${proj.id === currentProjectId ? "active" : ""}`;

    const info = document.createElement("div");
    info.className = "dropdown-item-info";
    const lockIcon = proj.is_locked ? `<span title="Projeto protegido por senha" style="font-size:0.75rem; margin-left:4px;">🔒</span>` : "";
    info.innerHTML = `
      <span>🎬</span>
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:130px;">${escapeHtml(proj.name)}</span>
      ${lockIcon}
    `;

    const meta = document.createElement("span");
    meta.className = "dropdown-item-meta";
    meta.textContent = `${proj.folders_count} pasta(s)`;

    item.appendChild(info);
    item.appendChild(meta);

    item.onclick = async () => {
      projectDropdownMenu.classList.add("hidden");
      await requestSwitchProject(proj.id);
    };

    projectDropdownList.appendChild(item);
  }
}

async function requestSwitchProject(projectId: string) {
  const proj = allProjects.find((p) => p.id === projectId);
  if (proj && proj.is_locked && !unlockedProjects.has(projectId)) {
    openUnlockPasswordModal(projectId);
    return;
  }
  await switchProject(projectId);
}

async function switchProject(projectId: string, password?: string) {
  // Invalida e para qualquer fila de extração em andamento imediatamente
  thumbQueueSessionId++;
  isQueueRunning = false;
  isQueuePaused = false;
  thumbProgressContainer.classList.add("hidden");

  // Reset visual e de TODOS os filtros do projeto anterior (para não interferir)
  selectedFilterTags.clear();
  excludedFilterTags.clear();
  filterSelectedSource = null;
  filterOnlyFavorites = false;
  filterOnlyUntagged = false;
  searchQuery = "";
  if (searchInput) searchInput.value = "";
  if (btnClearSearch) btnClearSearch.classList.add("hidden");

  selectedVideoIds.clear();
  selectedFolderPaths.clear();
  updateBatchActionBar();

  // Reset visual imediato do projeto anterior
  allVideos = [];
  statsBadge.textContent = "0 vídeos • 0 B";
  videoGrid.innerHTML = "";

  try {
    const result = await invoke<ProjectViewResult>("load_project_videos", {
      projectId,
      password: password || null,
    });

    currentProjectId = projectId;
    localStorage.setItem("lms_active_project_id", projectId);
    currentProjectIsLocked = !!result.is_locked;
    if (currentProjectIsLocked) {
      unlockedProjects.add(projectId);
    }
    updatePasswordLabels();

    currentProjectName = result.project_name;
    currentProjectFolders = result.folders;
    currentProjectFiles = result.individual_files || [];
    currentIncludeSubfolders = result.include_subfolders;
    allVideos = result.videos;
    availableProjectTags = result.available_tags;

    currentProjectNameEl.textContent = currentProjectName;
    const totalSources = currentProjectFolders.length + currentProjectFiles.length;
    foldersCountLabel.textContent = `Fontes (${totalSources})`;
    btnManageFolders.classList.remove("hidden");
    if (btnSyncProject) btnSyncProject.classList.remove("hidden");
    btnViewStats.classList.remove("hidden");

    renderProjectDropdown();
    renderSidebarFolders();

    if (activeSubviewPane === "sources") {
      renderSubviewSources();
    } else if (activeSubviewPane === "stats") {
      renderSubviewStats();
    }

    if (currentProjectFolders.length === 0 && currentProjectFiles.length === 0) {
      showNoFoldersState();
      return;
    }

    const totalSize = allVideos.reduce((acc, v) => acc + v.size_bytes, 0);
    statsBadge.textContent = `${allVideos.length} vídeos • ${formatFileSize(totalSize)}`;

    emptyStateNoProject.classList.add("hidden");
    emptyStateNoFolders.classList.add("hidden");
    videoGrid.classList.remove("hidden");

    // Restaurar ordenação, tamanho, visualização e agrupamento específicos deste projeto
    const savedSort = (result.sort_mode || localStorage.getItem(`lms_sort_${projectId}`)) as SortMode | null;
    const validSortModes: SortMode[] = [
      "name-asc", "name-desc", "date-desc", "date-asc",
      "size-desc", "size-asc", "duration-desc", "duration-asc",
      "plays-desc", "plays-asc", "recent-played"
    ];
    if (savedSort && validSortModes.includes(savedSort)) {
      setSortMode(savedSort, undefined, false);
    }
    const savedGrid = (result.grid_size || localStorage.getItem(`lms_grid_${projectId}`)) as ("small" | "medium" | "large") | null;
    if (savedGrid && ["small", "medium", "large"].includes(savedGrid)) {
      setGridSize(savedGrid, false);
    }
    const savedView = (result.view_mode || localStorage.getItem(`lms_view_${projectId}`)) as ViewMode | null;
    if (savedView && ["grid", "table"].includes(savedView)) {
      setViewMode(savedView, false);
    }
    const savedGroup = (result.group_by || localStorage.getItem(`lms_group_${projectId}`)) as GroupByMode | null;
    if (savedGroup && ["none", "folder", "tag", "date", "format", "status"].includes(savedGroup)) {
      setGroupBy(savedGroup, undefined, false);
    }

    renderTagFilters();
    renderGrid();
    startBackgroundThumbnailGeneration();

    if (activeSubviewPane !== null) {
      mainScrollViewport.classList.add("hidden");
      appContentTopbar?.classList.add("hidden");
    }
  } catch (err: any) {
    if (err === "PROJECT_LOCKED" || (typeof err === "string" && err.includes("PROJECT_LOCKED"))) {
      openUnlockPasswordModal(projectId);
      return;
    }
    console.error("Erro ao carregar projeto:", err);
  }
}

function showNoProjectState() {
  allVideos = [];
  statsBadge.textContent = "0 vídeos • 0 B";
  currentProjectNameEl.textContent = "Nenhum Projeto";
  btnManageFolders.classList.add("hidden");
  if (btnSyncProject) btnSyncProject.classList.add("hidden");
  btnViewStats.classList.add("hidden");
  videoGrid.classList.add("hidden");
  emptyStateNoFolders.classList.add("hidden");
  emptyStateNoProject.classList.remove("hidden");
  renderSidebarFolders();
  updateUIIndicators(0);
  closeWorkspaceSubview();
}

function showNoFoldersState() {
  allVideos = [];
  statsBadge.textContent = "0 vídeos • 0 B";
  videoGrid.classList.add("hidden");
  emptyStateNoProject.classList.add("hidden");
  emptyStateNoFolders.classList.remove("hidden");
  renderSidebarFolders();
  updateUIIndicators(0);
  if (activeSubviewPane !== null) {
    mainScrollViewport.classList.add("hidden");
    appContentTopbar?.classList.add("hidden");
  }
}

// QuickPick de Criação / Renomeação de Projeto (Estilo VS Code)
let quickpickMode: "create" | "rename" = "create";

function openQuickpickProject() {
  quickpickMode = "create";
  closeAllMenubarDropdowns();
  projectDropdownMenu.classList.add("hidden");
  if (!quickpickBar || !quickpickInput) return;
  quickpickBar.classList.remove("hidden");
  quickpickInput.placeholder = "Nome do novo projeto...";
  quickpickInput.value = "";
  quickpickInput.focus();
}

function openQuickpickRenameProject() {
  if (!currentProjectId) {
    showAlertDialog("Nenhum projeto selecionado para renomear.", "Aviso");
    return;
  }
  quickpickMode = "rename";
  closeAllMenubarDropdowns();
  projectDropdownMenu.classList.add("hidden");
  if (!quickpickBar || !quickpickInput) return;
  quickpickBar.classList.remove("hidden");
  quickpickInput.placeholder = "Novo nome do projeto...";
  quickpickInput.value = currentProjectName || "";
  quickpickInput.focus();
  quickpickInput.select();
}

function closeQuickpickProject() {
  if (!quickpickBar) return;
  quickpickBar.classList.add("hidden");
}

async function handleQuickpickSubmit() {
  if (!quickpickInput) return;
  const name = quickpickInput.value.trim();
  if (!name) return;

  if (quickpickMode === "create") {
    try {
      const created = await invoke<ProjectSummary>("create_project", { name });
      closeQuickpickProject();
      await refreshProjectsList();
      await switchProject(created.id);
    } catch (err) {
      await showAlertDialog(`Erro ao criar projeto: ${err}`, "Erro ao Criar Projeto");
    }
  } else if (quickpickMode === "rename") {
    if (!currentProjectId) return;
    try {
      await invoke("rename_project", { projectId: currentProjectId, newName: name });
      currentProjectName = name;
      currentProjectNameEl.textContent = name;
      closeQuickpickProject();
      await refreshProjectsList();
    } catch (err) {
      await showAlertDialog(`Erro ao renomear projeto: ${err}`, "Erro ao Renomear Projeto");
    }
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

type SubviewPane = "sources" | "settings" | "stats";
let activeSubviewPane: SubviewPane | null = null;

function openWorkspaceSubview(pane: SubviewPane) {
  closeAllMenubarDropdowns();
  activeSubviewPane = pane;
  appContentTopbar?.classList.add("hidden");
  mainScrollViewport.classList.add("hidden");
  workspaceSubview.classList.remove("hidden");

  subviewPaneSources.classList.add("hidden");
  subviewPaneSettings.classList.add("hidden");
  subviewPaneStats.classList.add("hidden");

  subviewBreadcrumbParent.textContent = currentProjectName || "LMS Explorer";

  if (pane === "sources") {
    subviewBreadcrumbCurrent.textContent = "Fontes de Mídia";
    subviewPaneSources.classList.remove("hidden");
    renderSubviewSources();
  } else if (pane === "settings") {
    subviewBreadcrumbCurrent.textContent = "Configurações";
    subviewPaneSettings.classList.remove("hidden");
    renderSubviewSettings();
  } else if (pane === "stats") {
    subviewBreadcrumbCurrent.textContent = "Métricas & Estatísticas";
    subviewPaneStats.classList.remove("hidden");
    renderSubviewStats();
  }
}

function closeWorkspaceSubview() {
  activeSubviewPane = null;
  workspaceSubview.classList.add("hidden");
  appContentTopbar?.classList.remove("hidden");
  mainScrollViewport.classList.remove("hidden");
}

function toggleFolderSelection(folder: string) {
  if (selectedFolderPaths.has(folder)) {
    selectedFolderPaths.delete(folder);
  } else {
    selectedFolderPaths.add(folder);
  }
  updateFolderSelectionUI();
}

function updateFolderSelectionUI() {
  const count = selectedFolderPaths.size;
  if (subviewBtnBatchRemoveFolders && subviewBatchRemoveFoldersLabel) {
    if (count > 0) {
      subviewBtnBatchRemoveFolders.classList.remove("hidden");
      subviewBatchRemoveFoldersLabel.textContent = `Desvincular (${count})`;
    } else {
      subviewBtnBatchRemoveFolders.classList.add("hidden");
    }
  }

  if (subviewFoldersSelectAll) {
    subviewFoldersSelectAll.checked =
      currentProjectFolders.length > 0 && selectedFolderPaths.size === currentProjectFolders.length;
    subviewFoldersSelectAll.indeterminate =
      selectedFolderPaths.size > 0 && selectedFolderPaths.size < currentProjectFolders.length;
  }

  const items = subviewFoldersList.querySelectorAll<HTMLElement>(".folder-card-item");
  items.forEach((item) => {
    const path = item.dataset.folder;
    if (!path) return;
    const isSel = selectedFolderPaths.has(path);
    item.classList.toggle("selected", isSel);
    const cb = item.querySelector<HTMLInputElement>(".folder-select-checkbox");
    if (cb) cb.checked = isSel;
  });
}

async function handleBatchRemoveFolders() {
  if (!currentProjectId || selectedFolderPaths.size === 0) return;
  const count = selectedFolderPaths.size;

  const confirmed = await showConfirmDialog({
    title: "Desvincular Pastas Selecionadas",
    message: `Deseja realmente desvincular as ${count} pastas selecionadas deste projeto?\n\n(Seus arquivos de vídeo físicos NÃO serão alterados ou excluídos do computador).`,
    confirmText: `Desvincular ${count} Pasta(s)`,
    cancelText: "Cancelar",
    danger: true,
    type: "warning",
  });

  if (!confirmed) return;

  try {
    await invoke("remove_folders_from_project", {
      projectId: currentProjectId,
      folderPaths: Array.from(selectedFolderPaths),
    });

    selectedFolderPaths.clear();
    await switchProject(currentProjectId);
    renderSubviewSources();
  } catch (err) {
    await showAlertDialog(`Erro ao desvincular pastas: ${err}`, "Erro");
  }
}

function renderSubviewSources() {
  subviewFoldersList.innerHTML = "";
  subviewFoldersCount.textContent = currentProjectFolders.length.toString();
  subviewLooseCountBadge.textContent = `${currentProjectFiles.length} vídeo${currentProjectFiles.length === 1 ? "" : "s"}`;
  subviewToggleSubfolders.checked = currentIncludeSubfolders;

  // Filtra seleção para apenas pastas válidas atuais
  const existingSet = new Set(currentProjectFolders);
  for (const f of Array.from(selectedFolderPaths)) {
    if (!existingSet.has(f)) {
      selectedFolderPaths.delete(f);
    }
  }

  if (subviewFoldersSelectAllWrap) {
    subviewFoldersSelectAllWrap.classList.toggle("hidden", currentProjectFolders.length <= 1);
  }

  updateFolderSelectionUI();

  if (currentProjectFolders.length === 0) {
    const emptySpan = document.createElement("div");
    emptySpan.style.padding = "2rem 1rem";
    emptySpan.style.textAlign = "center";
    emptySpan.style.fontSize = "0.85rem";
    emptySpan.style.color = "var(--text-muted)";
    emptySpan.innerHTML = `
      <div style="font-size:1.8rem; margin-bottom:0.5rem; opacity:0.6;">📁</div>
      <div style="font-weight: 500; color: var(--text-primary);">Nenhuma pasta vinculada a este projeto ainda.</div>
      <div style="font-size:0.75rem; margin-top:0.3rem; color:var(--text-muted);">Clique no botão "+ Vincular Nova Pasta" acima para adicionar pastas de vídeos do seu computador.</div>
    `;
    subviewFoldersList.appendChild(emptySpan);
    return;
  }

  for (const folder of currentProjectFolders) {
    const isSelected = selectedFolderPaths.has(folder);
    const card = document.createElement("div");
    card.className = `folder-card-item ${isSelected ? "selected" : ""}`;
    card.dataset.folder = folder;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "folder-select-checkbox";
    checkbox.checked = isSelected;
    checkbox.title = "Selecionar pasta para remoção múltipla";
    checkbox.onclick = (e) => {
      e.stopPropagation();
      toggleFolderSelection(folder);
    };

    const folderName = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
    const count = allVideos.filter((v) => v.folder_origin === folder).length;

    const infoCluster = document.createElement("div");
    infoCluster.className = "folder-info-cluster";
    infoCluster.innerHTML = `
      <div class="folder-icon-circle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        </svg>
      </div>
      <div class="folder-text-cluster">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="folder-name-title">${escapeHtml(folderName)}</span>
          <span class="nav-counter-pill">${count} vídeos</span>
        </div>
        <span class="folder-full-path" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
      </div>
    `;

    const actionsCluster = document.createElement("div");
    actionsCluster.style.display = "flex";
    actionsCluster.style.alignItems = "center";
    actionsCluster.style.gap = "6px";

    const explorerBtn = document.createElement("button");
    explorerBtn.className = "folder-remove-btn";
    explorerBtn.title = "Abrir pasta no Explorador de Arquivos";
    explorerBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
        <polyline points="15 3 21 3 21 9"></polyline>
        <line x1="10" y1="14" x2="21" y2="3"></line>
      </svg>
    `;
    explorerBtn.onclick = (e) => {
      e.stopPropagation();
      invoke("open_in_explorer", { videoPath: folder });
    };

    const removeBtn = document.createElement("button");
    removeBtn.className = "folder-remove-btn";
    removeBtn.title = "Desvincular esta pasta do projeto";
    removeBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 6h18"/>
        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
        <line x1="10" y1="11" x2="10" y2="17"/>
        <line x1="14" y1="11" x2="14" y2="17"/>
      </svg>
    `;
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      handleRemoveFolderFromProject(folder);
    };

    actionsCluster.appendChild(explorerBtn);
    actionsCluster.appendChild(removeBtn);

    card.appendChild(checkbox);
    card.appendChild(infoCluster);
    card.appendChild(actionsCluster);

    card.onclick = (e) => {
      if ((e.target as HTMLElement).closest(".folder-remove-btn") || (e.target as HTMLElement).closest("button")) {
        return;
      }
      toggleFolderSelection(folder);
    };

    subviewFoldersList.appendChild(card);
  }
}

function renderSubviewSettings() {
  subviewSettingHoverScrub.checked = hoverScrubbingEnabled;
  subviewSettingPlayer.value = preferredPlayer;
  subviewSettingConcurrency.value = concurrencySetting.toString();
}

async function renderSubviewStats() {
  if (!currentProjectId) return;
  try {
    const stats = await invoke<ProjectStats>("get_project_stats", { projectId: currentProjectId });

    subviewStatTotalVideos.textContent = stats.total_videos.toLocaleString();
    subviewStatTotalSize.textContent = formatFileSize(stats.total_size_bytes);
    subviewStatTotalDuration.textContent = formatDurationLong(stats.total_duration_secs);
    subviewStatTotalFavs.textContent = stats.total_favorites.toLocaleString();
    if (subviewStatTotalPlays) {
      subviewStatTotalPlays.textContent = (stats.total_plays || 0).toLocaleString();
    }

    // Top tags
    subviewStatsTopTags.innerHTML = "";
    if (stats.top_tags.length === 0) {
      subviewStatsTopTags.innerHTML = `<span style="font-size:0.8rem; color:var(--text-muted);">Nenhuma tag utilizada ainda neste projeto.</span>`;
    } else {
      const maxCount = Math.max(...stats.top_tags.map(([, count]) => count), 1);
      stats.top_tags.forEach(([tag, count]) => {
        const pct = Math.round((count / maxCount) * 100);
        const row = document.createElement("div");
        row.style.cssText = "display:flex; align-items:center; gap:12px; font-size:0.82rem;";
        row.innerHTML = `
          <span class="stats-tag-badge ${getTagColorClass(tag)}" style="min-width:110px;">#${escapeHtml(tag)}</span>
          <div style="flex:1; height:6px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:var(--accent-primary); border-radius:3px;"></div>
          </div>
          <span style="min-width:45px; text-align:right; font-family:var(--font-mono); color:var(--text-muted); font-size:0.75rem;">${count}</span>
        `;
        subviewStatsTopTags.appendChild(row);
      });
    }

    // Pastas
    subviewStatsFoldersSummary.innerHTML = "";
    if (stats.folders_summary.length === 0) {
      subviewStatsFoldersSummary.innerHTML = `<span style="font-size:0.8rem; color:var(--text-muted);">Nenhuma pasta vinculada ao projeto.</span>`;
    } else {
      stats.folders_summary.forEach(([folder, count]) => {
        const row = document.createElement("div");
        row.className = "stats-folder-row";
        row.innerHTML = `
          <span class="stats-folder-path" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
          <span class="stats-folder-count">${count} vídeos</span>
        `;
        subviewStatsFoldersSummary.appendChild(row);
      });
    }
  } catch (err) {
    await showAlertDialog(`Erro ao calcular métricas: ${err}`, "Erro ao Calcular Métricas");
  }
}

// Excluir Projeto
async function handleDeleteCurrentProject() {
  if (!currentProjectId) return;
  const confirmed = await showConfirmDialog({
    title: "Excluir Projeto",
    message: `Tem certeza que deseja excluir o projeto "${currentProjectName}"?\n\nSeus arquivos de vídeo continuarão intactos no disco.`,
    confirmText: "Excluir Projeto",
    cancelText: "Cancelar",
    danger: true,
    type: "danger",
  });

  if (!confirmed) return;

  try {
    await invoke("delete_project", { projectId: currentProjectId });
    closeWorkspaceSubview();
    localStorage.removeItem("lms_active_project_id");
    await refreshProjectsList();
  } catch (err) {
    await showAlertDialog(`Erro ao excluir projeto: ${err}`, "Erro");
  }
}

// Adicionar Pastas ao Projeto (permite múltiplas pastas)
async function handleAddFolderToProject() {
  if (!currentProjectId) return;

  try {
    const selected = await open({
      directory: true,
      multiple: true,
      title: `Selecione as Pastas para o Projeto "${currentProjectName}"`,
    });

    if (selected) {
      const folders = Array.isArray(selected) ? selected : [selected];
      if (folders.length > 0) {
        await invoke("add_folders_to_project", {
          projectId: currentProjectId,
          folderPaths: folders,
        });

        await switchProject(currentProjectId);
        renderSubviewSources();
      }
    }
  } catch (err) {
    console.error("Erro ao adicionar pastas:", err);
  }
}

// Remover Pasta do Projeto
async function handleRemoveFolderFromProject(folderPath: string) {
  if (!currentProjectId) return;

  const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
  const confirmed = await showConfirmDialog({
    title: "Desvincular Pasta",
    message: `Deseja desvincular a pasta "${folderName}" deste projeto?\n\nCaminho: ${folderPath}\n(Seus arquivos originais no disco não serão alterados)`,
    confirmText: "Desvincular",
    cancelText: "Cancelar",
    danger: true,
    type: "warning",
  });

  if (!confirmed) return;

  try {
    await invoke("remove_folder_from_project", {
      projectId: currentProjectId,
      folderPath,
    });

    await switchProject(currentProjectId);
    renderSubviewSources();
  } catch (err) {
    await showAlertDialog(`Erro ao remover pasta: ${err}`, "Erro");
  }
}

// Toggle de Subpastas
async function handleToggleSubfolders() {
  if (!currentProjectId) return;
  try {
    await invoke("toggle_subfolders", {
      projectId: currentProjectId,
      includeSubfolders: subviewToggleSubfolders.checked,
    });
    currentIncludeSubfolders = subviewToggleSubfolders.checked;
    await switchProject(currentProjectId);
    renderSubviewSources();
  } catch (err) {
    console.error("Erro ao alterar subpastas:", err);
  }
}

// Sincronização Inteligente
async function handleSyncProject() {
  if (!currentProjectId) return;
  if (subviewSyncStatusText) subviewSyncStatusText.textContent = "Sincronizando fontes de mídia com o disco...";
  subviewSyncStatusBanner?.classList.remove("hidden");
  if (subviewSyncBtnLabel) subviewSyncBtnLabel.textContent = "Sincronizando...";
  if (subviewBtnSync) subviewBtnSync.disabled = true;

  try {
    const report = await invoke<SyncReport>("sync_project", { projectId: currentProjectId });
    subviewSyncStatusBanner?.classList.add("hidden");
    if (subviewSyncBtnLabel) subviewSyncBtnLabel.textContent = "Sincronizar Arquivos";
    if (subviewBtnSync) subviewBtnSync.disabled = false;

    await showAlertDialog(
      `Sincronização concluída com sucesso!\n\n` +
      `• Total de vídeos atuais: ${report.total_count}\n` +
      `• Novos vídeos detectados: +${report.added_count}\n` +
      `• Arquivos removidos/inexistentes: -${report.removed_count}`,
      "Sincronização Concluída"
    );

    await switchProject(currentProjectId);
    renderSubviewSources();
  } catch (err) {
    subviewSyncStatusBanner?.classList.add("hidden");
    if (subviewSyncBtnLabel) subviewSyncBtnLabel.textContent = "Sincronizar Arquivos";
    if (subviewBtnSync) subviewBtnSync.disabled = false;
    await showAlertDialog(`Erro ao sincronizar: ${err}`, "Erro");
  }
}

// Adicionar Vídeos Avulsos via Dialog
async function handleAddFilesToProject() {
  if (!currentProjectId) {
    await showAlertDialog("Selecione ou crie um projeto primeiro.", "Nenhum Projeto Ativo");
    return;
  }

  try {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Selecione arquivos de vídeo para adicionar ao projeto",
      filters: [
        {
          name: "Vídeos",
          extensions: ["mp4", "mkv", "avi", "mov", "wmv", "webm", "flv", "m4v", "ts", "m2ts"],
        },
      ],
    });

    if (selected) {
      const filesToAdd = Array.isArray(selected) ? selected : [selected];
      if (filesToAdd.length > 0) {
        await invoke<ProjectViewResult>("add_individual_files", {
          projectId: currentProjectId,
          files: filesToAdd,
        });

        await switchProject(currentProjectId);
        renderSubviewSources();
      }
    }
  } catch (err) {
    console.error("Erro ao adicionar arquivos:", err);
  }
}

// Remover Arquivo Avulso do Projeto
async function handleRemoveFileFromProject(filePath: string) {
  if (!currentProjectId) return;
  try {
    await invoke("remove_individual_file", {
      projectId: currentProjectId,
      filePath,
    });
    await switchProject(currentProjectId);
    renderSubviewSources();
  } catch (err) {
    await showAlertDialog(`Erro ao remover arquivo: ${err}`, "Erro");
  }
}

// Processar Arquivos e Pastas Arrastados (Drag & Drop)
async function handleDroppedPaths(paths: string[]) {
  if (!paths || paths.length === 0) return;

  if (!currentProjectId) {
    await showAlertDialog("Por favor, crie ou selecione um projeto antes de soltar vídeos.", "Nenhum Projeto Ativo");
    return;
  }

  try {
    await invoke<ProjectViewResult>("add_dropped_paths", {
      projectId: currentProjectId,
      paths,
    });

    await switchProject(currentProjectId);
  } catch (err) {
    await showAlertDialog(`Erro ao adicionar arquivos arrastados: ${err}`, "Erro no Drag & Drop");
  }
}

// ============================================================
// BARRA LATERAL, INDICADORES E PAINEL
// ============================================================
function renderSidebarFolders() {
  if (!sidebarFoldersList) return;
  sidebarFoldersList.innerHTML = "";

  if (currentProjectFolders.length === 0 && currentProjectFiles.length === 0) {
    const emptySpan = document.createElement("span");
    emptySpan.style.fontSize = "0.72rem";
    emptySpan.style.color = "var(--text-muted)";
    emptySpan.style.padding = "0.3rem 0.5rem";
    emptySpan.textContent = "Nenhum arquivo ou pasta";
    sidebarFoldersList.appendChild(emptySpan);
    return;
  }

  for (const folder of currentProjectFolders) {
    const folderName = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
    const folderVideosCount = allVideos.filter((v) => v.folder_origin === folder).length;

    const row = document.createElement("div");
    row.className = `sidebar-folder-row ${filterSelectedSource === folder ? "active" : ""}`;
    row.title = `${folder} (${folderVideosCount} vídeos)`;
    row.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
      <span class="sidebar-folder-path">${folderName}</span>
      <span class="sidebar-folder-count">${folderVideosCount}</span>
    `;

    row.addEventListener("click", () => {
      if (filterSelectedSource === folder) {
        filterSelectedSource = null;
      } else {
        filterSelectedSource = folder;
        filterOnlyFavorites = false;
        filterOnlyUntagged = false;
        selectedFilterTags.clear();
      }
      renderTagFilters();
      renderSidebarFolders();
      renderGrid();
    });

    sidebarFoldersList.appendChild(row);
  }

  if (currentProjectFiles.length > 0) {
    const looseCount = currentProjectFiles.length;
    const row = document.createElement("div");
    row.className = `sidebar-folder-row ${filterSelectedSource === "__loose__" ? "active" : ""}`;
    row.title = `Vídeos adicionados avulsos (${looseCount} arquivos)`;
    row.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
      <span class="sidebar-folder-path">Vídeos Avulsos</span>
      <span class="sidebar-folder-count">${looseCount}</span>
    `;

    row.addEventListener("click", () => {
      if (filterSelectedSource === "__loose__") {
        filterSelectedSource = null;
      } else {
        filterSelectedSource = "__loose__";
        filterOnlyFavorites = false;
        filterOnlyUntagged = false;
        selectedFilterTags.clear();
      }
      renderTagFilters();
      renderSidebarFolders();
      renderGrid();
    });

    sidebarFoldersList.appendChild(row);
  }
}

function updateUIIndicators(filteredCount: number) {
  const total = allVideos.length;
  const favs = allVideos.filter((v) => v.is_favorite).length;
  const untagged = allVideos.filter((v) => v.tags.length === 0).length;
  const totalBytes = allVideos.reduce((acc, v) => acc + v.size_bytes, 0);

  if (sidebarCountAll) sidebarCountAll.textContent = total.toString();
  if (sidebarCountFavs) sidebarCountFavs.textContent = favs.toString();
  if (sidebarCountUntagged) sidebarCountUntagged.textContent = untagged.toString();
  if (currentViewCounter) currentViewCounter.textContent = filteredCount.toString();

  if (currentViewTitle) {
    if (filterSelectedSource === "__loose__") {
      currentViewTitle.textContent = "Vídeos Avulsos";
    } else if (filterSelectedSource) {
      const folderName = filterSelectedSource.split(/[\\/]/).filter(Boolean).pop() || filterSelectedSource;
      currentViewTitle.textContent = `Pasta: ${folderName}`;
    } else if (filterOnlyFavorites) {
      currentViewTitle.textContent = "Favoritos";
    } else if (filterOnlyUntagged) {
      currentViewTitle.textContent = "Sem Tags";
    } else if (selectedFilterTags.size > 0) {
      currentViewTitle.textContent = `Tag: ${Array.from(selectedFilterTags).join(", ")}`;
    } else {
      currentViewTitle.textContent = "Todos os Vídeos";
    }
  }

  if (statusbarProjectLabel) {
    statusbarProjectLabel.textContent = currentProjectName || "Nenhum Projeto";
  }
  if (statusbarSyncLabel) {
    statusbarSyncLabel.textContent = isQueueRunning ? "Processando miniaturas..." : "Pronto";
  }
  if (statusbarItemsSummary) {
    statusbarItemsSummary.textContent = `${filteredCount} de ${total} vídeos exibidos`;
  }
  if (statusbarStorageSummary) {
    statusbarStorageSummary.textContent = `${formatFileSize(totalBytes)} em disco`;
  }

  // Atualizar botões de navegação ativa da sidebar
  navAllVideos?.classList.toggle("active", !filterOnlyFavorites && !filterOnlyUntagged && selectedFilterTags.size === 0);
  filterFavBtn?.classList.toggle("active", filterOnlyFavorites);
  navUntaggedVideos?.classList.toggle("active", filterOnlyUntagged);
}

// ============================================================
// ORDENAÇÃO E ZOOM
// ============================================================
function getSortLabel(mode: SortMode): string {
  switch (mode) {
    case "name-asc": return "Nome (A-Z)";
    case "name-desc": return "Nome (Z-A)";
    case "date-desc": return "Mais Recentes";
    case "date-asc": return "Mais Antigos";
    case "size-desc": return "Maior Tamanho";
    case "size-asc": return "Menor Tamanho";
    case "duration-desc": return "Mais Longos";
    case "duration-asc": return "Mais Curtos";
    case "plays-desc": return "Mais Assistidos";
    case "plays-asc": return "Nunca Assistidos";
    case "recent-played": return "Assistidos Recentemente";
    default: return "Ordenar";
  }
}

function getGroupLabel(group: GroupByMode): string {
  switch (group) {
    case "none": return "Agrupar: Nenhum";
    case "folder": return "Agrupar: Pasta";
    case "tag": return "Agrupar: Tags";
    case "date": return "Agrupar: Data";
    case "format": return "Agrupar: Formato";
    case "status": return "Agrupar: Status";
    default: return "Agrupar";
  }
}

function setSortMode(mode: SortMode, label?: string, persist = true) {
  currentSortMode = mode;
  const displayLabel = label || getSortLabel(mode);
  localStorage.setItem("lms_sort_mode", mode);
  if (currentProjectId) {
    localStorage.setItem(`lms_sort_${currentProjectId}`, mode);
    if (persist) {
      invoke("update_project_settings", {
        projectId: currentProjectId,
        sortMode: mode,
        gridSize: currentGridSize,
        viewMode: currentViewMode,
        groupBy: currentGroupBy,
      }).catch((err) => console.error("Erro ao salvar ordenação no projeto:", err));
    }
  }
  if (sortLabel) sortLabel.textContent = displayLabel;
  sortDropdownMenu?.classList.add("hidden");

  document.querySelectorAll(".sort-option").forEach((opt) => {
    opt.classList.toggle("active", opt.getAttribute("data-sort") === mode);
  });

  updateViewContextMenuState();
  renderGrid();
}

function setGridSize(size: "small" | "medium" | "large", persist = true) {
  currentGridSize = size;
  localStorage.setItem("lms_grid_size", size);
  if (currentProjectId) {
    localStorage.setItem(`lms_grid_${currentProjectId}`, size);
    if (persist) {
      invoke("update_project_settings", {
        projectId: currentProjectId,
        sortMode: currentSortMode,
        gridSize: size,
        viewMode: currentViewMode,
        groupBy: currentGroupBy,
      }).catch((err) => console.error("Erro ao salvar tamanho do grid no projeto:", err));
    }
  }
  videoGrid.classList.remove("size-small", "size-medium", "size-large");
  videoGrid.classList.add(`size-${size}`);

  // Atualizar imediatamente qualquer subgrade em modo de agrupamento
  videoGrid.querySelectorAll(".video-gallery-grid").forEach((grid) => {
    grid.classList.remove("size-small", "size-medium", "size-large");
    grid.classList.add(`size-${size}`);
  });

  zoomBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-size") === size);
  });

  updateViewContextMenuState();
}

function setViewMode(mode: ViewMode, persist = true) {
  currentViewMode = mode;
  localStorage.setItem("lms_view_mode", mode);
  if (currentProjectId) {
    localStorage.setItem(`lms_view_${currentProjectId}`, mode);
    if (persist) {
      invoke("update_project_settings", {
        projectId: currentProjectId,
        sortMode: currentSortMode,
        gridSize: currentGridSize,
        viewMode: mode,
        groupBy: currentGroupBy,
      }).catch((err) => console.error("Erro ao salvar modo de visualização:", err));
    }
  }

  btnViewGrid?.classList.toggle("active", mode === "grid");
  btnViewTable?.classList.toggle("active", mode === "table");

  updateViewContextMenuState();
  renderGrid();
}

function setGroupBy(group: GroupByMode, label?: string, persist = true) {
  currentGroupBy = group;
  const displayLabel = label || getGroupLabel(group);
  localStorage.setItem("lms_group_by", group);
  if (currentProjectId) {
    localStorage.setItem(`lms_group_${currentProjectId}`, group);
    if (persist) {
      invoke("update_project_settings", {
        projectId: currentProjectId,
        sortMode: currentSortMode,
        gridSize: currentGridSize,
        viewMode: currentViewMode,
        groupBy: group,
      }).catch((err) => console.error("Erro ao salvar agrupamento no projeto:", err));
    }
  }

  if (groupLabel) groupLabel.textContent = displayLabel;
  groupDropdownMenu?.classList.add("hidden");

  document.querySelectorAll(".group-option").forEach((opt) => {
    opt.classList.toggle("active", opt.getAttribute("data-group") === group);
  });

  updateViewContextMenuState();
  renderGrid();
}

function formatRelativeTime(timestampSec: number | null | undefined): string {
  if (!timestampSec || timestampSec <= 0) return "Nunca";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestampSec;
  if (diff < 60) return "Agora";
  if (diff < 3600) return `Há ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `Há ${Math.floor(diff / 3600)}h`;
  if (diff < 7 * 86400) return `Há ${Math.floor(diff / 86400)}d`;
  const d = new Date(timestampSec * 1000);
  return d.toLocaleDateString("pt-BR");
}

function formatDate(timestampSec: number): string {
  if (!timestampSec || timestampSec <= 0) return "--";
  const d = new Date(timestampSec * 1000);
  return d.toLocaleDateString("pt-BR");
}

// Normaliza strings removendo acentos/diacríticos e convertendo para minúsculas
function normalizeSearchText(str: string): string {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getSortedAndFilteredVideos(): VideoItem[] {
  const normalizedQuery = normalizeSearchText(searchQuery);
  const searchTerms = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];

  let list = allVideos.filter((video) => {
    if (searchTerms.length > 0) {
      const normalizedName = normalizeSearchText(video.name);
      for (const term of searchTerms) {
        const matchesName = normalizedName.includes(term);
        const matchesTag = video.tags.some((t) => normalizeSearchText(t).includes(term));
        if (!matchesName && !matchesTag) return false;
      }
    }

    if (filterOnlyFavorites && !video.is_favorite) {
      return false;
    }

    if (filterOnlyUntagged && video.tags.length > 0) {
      return false;
    }

    if (selectedFilterTags.size > 0) {
      for (const tag of selectedFilterTags) {
        if (!video.tags.includes(tag)) return false;
      }
    }

    if (excludedFilterTags.size > 0) {
      for (const tag of excludedFilterTags) {
        if (video.tags.includes(tag)) return false;
      }
    }

    if (filterSelectedSource !== null) {
      if (filterSelectedSource === "__loose__") {
        if (!currentProjectFiles.includes(video.path) && video.folder_origin !== "Arquivo Avulso") {
          return false;
        }
      } else {
        if (video.folder_origin !== filterSelectedSource) {
          return false;
        }
      }
    }

    return true;
  });

  list.sort((a, b) => {
    switch (currentSortMode) {
      case "name-asc":
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      case "name-desc":
        return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" });
      case "date-desc":
        return b.modified - a.modified;
      case "date-asc":
        return a.modified - b.modified;
      case "size-desc":
        return b.size_bytes - a.size_bytes;
      case "size-asc":
        return a.size_bytes - b.size_bytes;
      case "duration-desc":
        return (b.duration_secs || 0) - (a.duration_secs || 0);
      case "duration-asc":
        return (a.duration_secs || 0) - (b.duration_secs || 0);
      case "plays-desc":
        return (b.play_count || 0) - (a.play_count || 0);
      case "plays-asc":
        return (a.play_count || 0) - (b.play_count || 0);
      case "recent-played":
        return (b.last_played || 0) - (a.last_played || 0);
      default:
        return 0;
    }
  });

  return list;
}

interface VideoGroup {
  id: string;
  title: string;
  videos: VideoItem[];
}

function groupVideos(videos: VideoItem[], mode: GroupByMode): VideoGroup[] {
  if (mode === "none" || videos.length === 0) {
    return [{ id: "all", title: "Todos os Vídeos", videos }];
  }

  const map = new Map<string, { title: string; videos: VideoItem[] }>();

  for (const video of videos) {
    let key = "";
    let title = "";

    switch (mode) {
      case "folder": {
        const folder = video.folder_origin || "Sem Pasta";
        key = `folder_${folder}`;
        title = folder;
        break;
      }
      case "tag": {
        if (video.tags && video.tags.length > 0) {
          const primary = video.tags[0];
          key = `tag_${primary}`;
          title = `#${primary}`;
        } else {
          key = "tag__untagged";
          title = "Sem Tags";
        }
        break;
      }
      case "date": {
        const nowSec = Math.floor(Date.now() / 1000);
        const diffSec = nowSec - (video.modified || 0);
        if (diffSec < 86400) {
          key = "date_today";
          title = "Hoje";
        } else if (diffSec < 7 * 86400) {
          key = "date_week";
          title = "Esta Semana";
        } else if (diffSec < 30 * 86400) {
          key = "date_month";
          title = "Este Mês";
        } else {
          key = "date_older";
          title = "Mais Antigos";
        }
        break;
      }
      case "format": {
        const parts = video.name.split(".");
        const ext = parts.length > 1 ? parts.pop()!.toUpperCase() : "OUTROS";
        key = `format_${ext}`;
        title = ext;
        break;
      }
      case "status": {
        if (video.play_count && video.play_count > 0) {
          key = "status_watched";
          title = "Assistidos";
        } else {
          key = "status_unwatched";
          title = "Nunca Assistidos";
        }
        break;
      }
    }

    if (!map.has(key)) {
      map.set(key, { title, videos: [] });
    }
    map.get(key)!.videos.push(video);
  }

  const groups: VideoGroup[] = [];
  for (const [id, grp] of map.entries()) {
    groups.push({ id, title: grp.title, videos: grp.videos });
  }

  if (mode === "date") {
    const order = ["date_today", "date_week", "date_month", "date_older"];
    groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  } else if (mode === "status") {
    const order = ["status_watched", "status_unwatched"];
    groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  } else {
    groups.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }

  return groups;
}

// ============================================================
// CONSTRUÇÃO MODULAR DE CARDS E TABELA
// ============================================================
function createVideoCard(video: VideoItem, currentFiltered: VideoItem[]): HTMLElement {
  const isSelected = selectedVideoIds.has(video.id);

  const card = document.createElement("div");
  card.className = `notion-card ${isSelected ? "selected-in-batch" : ""}`;
  card.dataset.id = video.id;
  card.dataset.path = video.path;

  // Checkbox de Seleção em Lote (com SVG)
  const selectCheck = document.createElement("div");
  selectCheck.className = `card-select-checkbox ${isSelected ? "checked" : ""}`;
  selectCheck.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
  selectCheck.title = "Selecionar para ações em lote";
  selectCheck.onclick = (e) => {
    e.stopPropagation();
    toggleSelectVideo(video.id);
    lastSelectedVideoId = video.id;
  };

  // Capa do Card
  const mediaWrapper = document.createElement("div");
  mediaWrapper.className = "card-media-wrapper";

  if (video.thumbnail) {
    const img = document.createElement("img");
    img.className = "card-media-img";
    img.src = convertFileSrc(video.thumbnail);
    img.loading = "lazy";
    img.alt = video.name;
    mediaWrapper.appendChild(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "card-media-fallback";
    fallback.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:26px;height:26px;"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 12h18"/></svg>
      <span>Carregando...</span>
    `;
    mediaWrapper.appendChild(fallback);
  }

  // Camada de Hover Scrubbing (Lazy on Hover)
  const scrubLayer = document.createElement("div");
  scrubLayer.className = `card-media-scrub ${video.scrub_sprite && hoverScrubbingEnabled ? "has-sprite" : ""}`;
  if (video.scrub_sprite && hoverScrubbingEnabled) {
    scrubLayer.style.backgroundImage = `url("${convertFileSrc(video.scrub_sprite)}")`;
  }
  mediaWrapper.appendChild(scrubLayer);

  // Play Overlay Icon (aparece no hover com blur)
  const playOverlay = document.createElement("div");
  playOverlay.className = "card-hover-overlay";
  playOverlay.innerHTML = `<div class="play-action-circle"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8 5 19 12 8 19 8 5"/></svg></div>`;
  mediaWrapper.appendChild(playOverlay);

  let isFetchingScrub = false;
  mediaWrapper.onmouseenter = async () => {
    if (!hoverScrubbingEnabled) return;
    if (!video.scrub_sprite && !isFetchingScrub && video.duration_secs > 3) {
      isFetchingScrub = true;
      try {
        const spriteUrl = await invoke<string>("generate_hover_scrub", {
          videoPath: video.path,
          duration: video.duration_secs,
        });
        video.scrub_sprite = spriteUrl;
        if (hoverScrubbingEnabled) {
          scrubLayer.classList.add("has-sprite");
          scrubLayer.style.backgroundImage = `url("${convertFileSrc(spriteUrl)}")`;
        }
      } catch {
        // ignore
      }
    }
  };

  mediaWrapper.onmousemove = (e: MouseEvent) => {
    if (!hoverScrubbingEnabled || !video.scrub_sprite) return;
    const rect = mediaWrapper.getBoundingClientRect();
    const posX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = posX / rect.width;
    const frameIndex = Math.min(3, Math.floor(ratio * 4));
    scrubLayer.style.backgroundPosition = `${frameIndex * 33.333}% 0%`;
  };

  // Badge de Formato / Extensão (Ex: MP4, MKV)
  const ext = video.name.split(".").pop()?.toUpperCase() || "VID";
  const extBadge = document.createElement("span");
  extBadge.className = "card-format-badge";
  extBadge.textContent = ext;
  mediaWrapper.appendChild(extBadge);

  // Badge de Reproduções
  const playsBadge = document.createElement("div");
  playsBadge.className = `card-plays-badge ${(video.play_count || 0) > 0 ? "has-plays" : ""}`;
  playsBadge.title = `Reproduzido ${video.play_count || 0} vezes. Última vez: ${formatRelativeTime(video.last_played)}`;
  playsBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><span>${video.play_count || 0}</span>`;
  mediaWrapper.appendChild(playsBadge);

  // Botão Estrela com SVG
  const starBtn = document.createElement("button");
  starBtn.className = `card-star-btn ${video.is_favorite ? "starred" : ""}`;
  starBtn.innerHTML = video.is_favorite
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  starBtn.title = video.is_favorite ? "Remover dos favoritos" : "Favoritar vídeo";
  starBtn.onclick = (e) => {
    e.stopPropagation();
    toggleFavorite(video);
  };
  mediaWrapper.appendChild(starBtn);

  // Badge de Duração Estampada
  if (video.duration_secs > 0) {
    const durBadge = document.createElement("div");
    durBadge.className = "card-duration-badge";
    durBadge.textContent = formatDuration(video.duration_secs);
    mediaWrapper.appendChild(durBadge);
  }

  mediaWrapper.appendChild(selectCheck);
  card.appendChild(mediaWrapper);

  // Corpo de Detalhes
  const body = document.createElement("div");
  body.className = "card-content-body";

  const title = document.createElement("div");
  title.className = "card-title-text";
  title.textContent = video.name;
  title.title = video.name;
  body.appendChild(title);

  const propRow = document.createElement("div");
  propRow.className = "card-properties-row";

  // Tags
  const tagsGroup = document.createElement("div");
  tagsGroup.className = "card-tags-group";
  video.tags.slice(0, 3).forEach((tag) => {
    const pill = document.createElement("span");
    pill.className = `card-tag-pill ${getTagColorClass(tag)}`;
    pill.textContent = tag;
    tagsGroup.appendChild(pill);
  });
  if (video.tags.length > 3) {
    const more = document.createElement("span");
    more.className = "card-tag-pill tag-color-gray";
    more.textContent = `+${video.tags.length - 3}`;
    tagsGroup.appendChild(more);
  }
  propRow.appendChild(tagsGroup);

  // Tamanho do arquivo
  const size = document.createElement("span");
  size.className = "card-file-size";
  size.textContent = formatFileSize(video.size_bytes);
  propRow.appendChild(size);

  body.appendChild(propRow);
  card.appendChild(body);

  // Duplo clique: Reproduzir
  card.ondblclick = () => {
    playVideo(video.path);
  };

  // Clique: Seleção desktop nativa (Normal, Ctrl para múltiplo, Shift para intervalo)
  card.onclick = (e) => {
    handleCardClick(e, video, currentFiltered);
  };

  // Botão Direito: Menu de Contexto
  card.oncontextmenu = (e) => {
    e.preventDefault();
    if (!selectedVideoIds.has(video.id)) {
      selectSingleVideo(video.id);
    }
    openContextMenu(e, video);
  };

  return card;
}

function createVideoTable(videos: VideoItem[], currentFiltered: VideoItem[]): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "notion-table-wrapper";

  const table = document.createElement("table");
  table.className = "notion-table";

  // Thead
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th class="table-check-col">
        <input type="checkbox" class="table-header-select-all" title="Selecionar Todos neste grupo" />
      </th>
      <th class="table-thumb-col">Mídia</th>
      <th class="table-name-col">Nome do Arquivo</th>
      <th>Duração</th>
      <th>Tamanho</th>
      <th>Reproduções</th>
      <th>Última Reprodução</th>
      <th>Modificado</th>
      <th>Tags</th>
      <th class="table-star-col"></th>
    </tr>
  `;

  const headerCheck = thead.querySelector<HTMLInputElement>(".table-header-select-all");
  if (headerCheck) {
    const allSelected = videos.length > 0 && videos.every((v) => selectedVideoIds.has(v.id));
    headerCheck.checked = allSelected;
    headerCheck.onclick = (e) => {
      e.stopPropagation();
      const isChecked = headerCheck.checked;
      for (const v of videos) {
        if (isChecked) {
          selectedVideoIds.add(v.id);
        } else {
          selectedVideoIds.delete(v.id);
        }
      }
      updateSelectionVisuals();
    };
  }

  table.appendChild(thead);

  // Tbody
  const tbody = document.createElement("tbody");

  for (const video of videos) {
    const isSelected = selectedVideoIds.has(video.id);

    const tr = document.createElement("tr");
    tr.className = `notion-table-row ${isSelected ? "selected-in-batch" : ""}`;
    tr.dataset.id = video.id;
    tr.dataset.path = video.path;

    // Checkbox Col
    const tdCheck = document.createElement("td");
    tdCheck.className = "table-check-col";
    const rowCheck = document.createElement("input");
    rowCheck.type = "checkbox";
    rowCheck.className = "table-row-checkbox";
    rowCheck.checked = isSelected;
    rowCheck.onclick = (e) => {
      e.stopPropagation();
      toggleSelectVideo(video.id);
      lastSelectedVideoId = video.id;
    };
    tdCheck.appendChild(rowCheck);
    tr.appendChild(tdCheck);

    // Miniatura Col
    const tdThumb = document.createElement("td");
    tdThumb.className = "table-thumb-col";
    const thumbWrap = document.createElement("div");
    thumbWrap.className = "table-thumb-preview";
    if (video.thumbnail) {
      const img = document.createElement("img");
      img.src = convertFileSrc(video.thumbnail);
      img.loading = "lazy";
      img.alt = video.name;
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:18px;height:18px;color:var(--text-muted);"><rect width="18" height="18" x="3" y="3" rx="2"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>`;
    }
    tdThumb.appendChild(thumbWrap);
    tr.appendChild(tdThumb);

    // Nome Col
    const tdName = document.createElement("td");
    tdName.className = "table-name-col";
    const titleCell = document.createElement("div");
    titleCell.className = "table-title-cell";

    const ext = video.name.split(".").pop()?.toUpperCase() || "VID";
    const extBadge = document.createElement("span");
    extBadge.className = "table-format-badge";
    extBadge.textContent = ext;

    const titleText = document.createElement("span");
    titleText.className = "table-title-text";
    titleText.textContent = video.name;
    titleText.title = video.name;

    titleCell.appendChild(extBadge);
    titleCell.appendChild(titleText);
    tdName.appendChild(titleCell);
    tr.appendChild(tdName);

    // Duração Col
    const tdDur = document.createElement("td");
    tdDur.className = "table-mono-cell";
    tdDur.textContent = video.duration_secs > 0 ? formatDuration(video.duration_secs) : "--:--";
    tr.appendChild(tdDur);

    // Tamanho Col
    const tdSize = document.createElement("td");
    tdSize.className = "table-mono-cell";
    tdSize.textContent = formatFileSize(video.size_bytes);
    tr.appendChild(tdSize);

    // Reproduções Col
    const tdPlays = document.createElement("td");
    const playsBadge = document.createElement("span");
    playsBadge.className = `table-plays-badge ${(video.play_count || 0) > 0 ? "has-plays" : ""}`;
    playsBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><span>${video.play_count || 0}</span>`;
    tdPlays.appendChild(playsBadge);
    tr.appendChild(tdPlays);

    // Última Reprodução Col
    const tdLastPlayed = document.createElement("td");
    tdLastPlayed.className = "table-mono-cell table-last-played-cell";
    tdLastPlayed.textContent = formatRelativeTime(video.last_played);
    tr.appendChild(tdLastPlayed);

    // Modificado Col
    const tdMod = document.createElement("td");
    tdMod.className = "table-mono-cell";
    tdMod.textContent = formatDate(video.modified);
    tr.appendChild(tdMod);

    // Tags Col
    const tdTags = document.createElement("td");
    const tagsCluster = document.createElement("div");
    tagsCluster.className = "card-tags-group";
    video.tags.slice(0, 3).forEach((tag) => {
      const pill = document.createElement("span");
      pill.className = `card-tag-pill ${getTagColorClass(tag)}`;
      pill.textContent = tag;
      tagsCluster.appendChild(pill);
    });
    if (video.tags.length > 3) {
      const more = document.createElement("span");
      more.className = "card-tag-pill tag-color-gray";
      more.textContent = `+${video.tags.length - 3}`;
      tagsCluster.appendChild(more);
    }
    tdTags.appendChild(tagsCluster);
    tr.appendChild(tdTags);

    // Star Col
    const tdStar = document.createElement("td");
    tdStar.className = "table-star-col";
    const starBtn = document.createElement("button");
    starBtn.className = `table-star-btn ${video.is_favorite ? "starred" : ""}`;
    starBtn.innerHTML = video.is_favorite
      ? `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    starBtn.title = video.is_favorite ? "Remover dos favoritos" : "Favoritar vídeo";
    starBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(video);
    };
    tdStar.appendChild(starBtn);
    tr.appendChild(tdStar);

    // Row Interactions
    tr.ondblclick = () => {
      playVideo(video.path);
    };

    tr.onclick = (e) => {
      handleCardClick(e, video, currentFiltered);
    };

    tr.oncontextmenu = (e) => {
      e.preventDefault();
      if (!selectedVideoIds.has(video.id)) {
        selectSingleVideo(video.id);
      }
      openContextMenu(e, video);
    };

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}

// ============================================================
// RENDERIZAÇÃO DO GRID & TABELA COM AGRUPAMENTO DINÂMICO
// ============================================================
function renderGrid() {
  const filtered = getSortedAndFilteredVideos();
  videoGrid.innerHTML = "";

  if (filtered.length === 0) {
    noResults.classList.remove("hidden");
    updateUIIndicators(0);
    return;
  }
  noResults.classList.add("hidden");

  if (currentGroupBy !== "none") {
    videoGrid.className = "video-groups-container";
    const groups = groupVideos(filtered, currentGroupBy);

    for (const group of groups) {
      const section = document.createElement("div");
      section.className = `video-group-section ${collapsedGroupIds.has(group.id) ? "collapsed" : ""}`;
      section.dataset.groupId = group.id;

      const groupTotalSize = group.videos.reduce((acc, v) => acc + v.size_bytes, 0);
      const groupTotalDur = group.videos.reduce((acc, v) => acc + (v.duration_secs || 0), 0);

      const header = document.createElement("div");
      header.className = "video-group-header";
      header.innerHTML = `
        <div class="video-group-title-wrap">
          <svg class="video-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span class="video-group-title" title="${escapeHtml(group.title)}">${escapeHtml(group.title)}</span>
          <span class="video-group-count-badge">${group.videos.length}</span>
        </div>
        <div class="video-group-stats-pill">
          ${formatFileSize(groupTotalSize)}${groupTotalDur > 0 ? ` • ${formatDurationLong(groupTotalDur)}` : ""}
        </div>
      `;

      header.onclick = () => {
        if (collapsedGroupIds.has(group.id)) {
          collapsedGroupIds.delete(group.id);
          section.classList.remove("collapsed");
        } else {
          collapsedGroupIds.add(group.id);
          section.classList.add("collapsed");
        }
      };

      const content = document.createElement("div");
      content.className = "video-group-content";

      if (currentViewMode === "grid") {
        const gridInner = document.createElement("div");
        gridInner.className = `video-gallery-grid size-${currentGridSize}`;
        for (const video of group.videos) {
          gridInner.appendChild(createVideoCard(video, filtered));
        }
        content.appendChild(gridInner);
      } else {
        content.appendChild(createVideoTable(group.videos, filtered));
      }

      section.appendChild(header);
      section.appendChild(content);
      videoGrid.appendChild(section);
    }
  } else {
    // Sem agrupamento (padrão linear)
    if (currentViewMode === "grid") {
      videoGrid.className = `video-gallery-grid size-${currentGridSize}`;
      const fragment = document.createDocumentFragment();
      for (const video of filtered) {
        fragment.appendChild(createVideoCard(video, filtered));
      }
      videoGrid.appendChild(fragment);
    } else {
      videoGrid.className = "video-table-mode-container";
      videoGrid.appendChild(createVideoTable(filtered, filtered));
    }
  }

  updateUIIndicators(filtered.length);
}

function updatePlayBadgesInDom(video: VideoItem) {
  const cards = videoGrid.querySelectorAll<HTMLElement>(`.notion-card[data-id="${video.id}"]`);
  cards.forEach((card) => {
    const badge = card.querySelector<HTMLElement>(".card-plays-badge");
    if (badge) {
      badge.classList.toggle("has-plays", (video.play_count || 0) > 0);
      badge.title = `Reproduzido ${video.play_count || 0} vezes. Última vez: ${formatRelativeTime(video.last_played)}`;
      const span = badge.querySelector<HTMLElement>("span");
      if (span) span.textContent = (video.play_count || 0).toString();
    }
  });

  const rows = videoGrid.querySelectorAll<HTMLElement>(`.notion-table-row[data-id="${video.id}"]`);
  rows.forEach((row) => {
    const badge = row.querySelector<HTMLElement>(".table-plays-badge");
    if (badge) {
      badge.classList.toggle("has-plays", (video.play_count || 0) > 0);
      const span = badge.querySelector<HTMLElement>("span");
      if (span) span.textContent = (video.play_count || 0).toString();
    }
    const lastPlayedCell = row.querySelector<HTMLElement>(".table-last-played-cell");
    if (lastPlayedCell) {
      lastPlayedCell.textContent = formatRelativeTime(video.last_played);
    }
  });
}

// Reproduzir Vídeo
async function playVideo(videoPath: string) {
  try {
    invoke("open_in_player", { videoPath, preferredPlayer });
    if (currentProjectId) {
      invoke<VideoPlayInfo>("record_video_play", { projectId: currentProjectId, videoPath })
        .then((info) => {
          const v = allVideos.find((item) => item.path === videoPath);
          if (v) {
            v.play_count = info.play_count;
            v.last_played = info.last_played;
            updatePlayBadgesInDom(v);
          }
        })
        .catch((err) => console.warn("Erro ao registrar reprodução:", err));
    }
  } catch (err) {
    console.error("Erro ao abrir vídeo:", err);
  }
}

// Alternar Favorito
async function toggleFavorite(video: VideoItem) {
  if (!currentProjectId) return;
  try {
    const isFav = await invoke<boolean>("toggle_favorite", {
      projectId: currentProjectId,
      videoPath: video.path,
    });
    video.is_favorite = isFav;
    renderGrid();
    updateRandomModalMatchingCount();
  } catch (err) {
    console.error("Erro ao favoritar:", err);
  }
}

// ============================================================
// SELEÇÃO E AÇÕES EM LOTE (DESKTOP SELECTION & BATCH ACTIONS)
// ============================================================
function updateSelectionVisuals() {
  updateBatchActionBar();
  const cards = videoGrid.querySelectorAll<HTMLElement>(".notion-card");
  cards.forEach((card) => {
    const id = card.dataset.id;
    if (!id) return;
    const isSelected = selectedVideoIds.has(id);
    card.classList.toggle("selected-in-batch", isSelected);
    const check = card.querySelector<HTMLElement>(".card-select-checkbox");
    if (check) {
      check.classList.toggle("checked", isSelected);
    }
  });

  const rows = videoGrid.querySelectorAll<HTMLElement>(".notion-table-row");
  rows.forEach((row) => {
    const id = row.dataset.id;
    if (!id) return;
    const isSelected = selectedVideoIds.has(id);
    row.classList.toggle("selected-in-batch", isSelected);
    const checkInput = row.querySelector<HTMLInputElement>(".table-row-checkbox");
    if (checkInput) {
      checkInput.checked = isSelected;
    }
  });
}

function handleCardClick(e: MouseEvent, video: VideoItem, currentList: VideoItem[]) {
  // Ignora se estiver renomeando inline ou interagindo com botão interno
  if ((e.target as HTMLElement).closest(".card-inline-rename-input") || (e.target as HTMLElement).closest("button")) {
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    toggleSelectVideo(video.id);
    lastSelectedVideoId = video.id;
  } else if (e.shiftKey && lastSelectedVideoId) {
    const lastIdx = currentList.findIndex((v) => v.id === lastSelectedVideoId);
    const currIdx = currentList.findIndex((v) => v.id === video.id);
    if (lastIdx !== -1 && currIdx !== -1) {
      const start = Math.min(lastIdx, currIdx);
      const end = Math.max(lastIdx, currIdx);
      selectedVideoIds.clear();
      for (let i = start; i <= end; i++) {
        selectedVideoIds.add(currentList[i].id);
      }
      updateSelectionVisuals();
    } else {
      selectSingleVideo(video.id);
    }
  } else {
    selectSingleVideo(video.id);
  }
}

function selectSingleVideo(videoId: string) {
  selectedVideoIds.clear();
  selectedVideoIds.add(videoId);
  lastSelectedVideoId = videoId;
  updateSelectionVisuals();
}

function toggleSelectVideo(videoId: string) {
  if (selectedVideoIds.has(videoId)) {
    selectedVideoIds.delete(videoId);
  } else {
    selectedVideoIds.add(videoId);
  }
  updateSelectionVisuals();
}

function updateBatchActionBar() {
  const count = selectedVideoIds.size;
  if (count > 0) {
    document.body.classList.add("has-batch-selection");
    batchSelectedCount.textContent = `${count} vídeo(s) selecionado(s)`;
    batchActionBar.classList.remove("hidden");
  } else {
    document.body.classList.remove("has-batch-selection");
    batchActionBar.classList.add("hidden");
  }
}

function clearBatchSelection() {
  selectedVideoIds.clear();
  lastSelectedVideoId = null;
  updateSelectionVisuals();
}

function selectAllVideos() {
  const filtered = getSortedAndFilteredVideos();
  for (const v of filtered) {
    selectedVideoIds.add(v.id);
  }
  updateSelectionVisuals();
}

function getSelectedVideoPaths(): string[] {
  return allVideos.filter((v) => selectedVideoIds.has(v.id)).map((v) => v.path);
}

// Batch Favoritar
async function handleBatchFavorite() {
  if (!currentProjectId || selectedVideoIds.size === 0) return;
  const paths = getSelectedVideoPaths();

  try {
    await invoke("batch_toggle_favorite", {
      projectId: currentProjectId,
      videoPaths: paths,
      favorite: true,
    });

    allVideos.forEach((v) => {
      if (selectedVideoIds.has(v.id)) v.is_favorite = true;
    });

    clearBatchSelection();
    updateRandomModalMatchingCount();
  } catch (err) {
    await showAlertDialog(`Erro ao favoritar em lote: ${err}`, "Erro");
  }
}

// Batch Abrir Modal de Tags
function openBatchTagsModal(mode: "add" | "remove") {
  batchTagMode = mode;
  batchTagsModalTitle.textContent = mode === "add" ? "Adicionar Tag em Lote" : "Remover Tag em Lote";
  batchTagsModalDesc.textContent =
    mode === "add"
      ? `Selecione ou digite a tag que deseja aplicar a todos os ${selectedVideoIds.size} vídeos selecionados.`
      : `Selecione a tag que deseja remover de todos os ${selectedVideoIds.size} vídeos selecionados.`;

  batchNewTagInputGroup.classList.toggle("hidden", mode === "remove");
  batchTagInput.value = "";
  renderBatchModalTagsList();
  batchTagsModal.classList.remove("hidden");
}

let batchSelectedModalTags: Set<string> = new Set();

function renderBatchModalTagsList() {
  batchModalTagsList.innerHTML = "";
  batchSelectedModalTags.clear();

  if (availableProjectTags.length === 0) {
    batchModalTagsList.innerHTML = `<span style="font-size:0.75rem; color:var(--nt-text-muted);">Nenhuma tag criada no projeto ainda.</span>`;
    return;
  }

  for (const tag of availableProjectTags) {
    const chip = document.createElement("div");
    chip.className = `selectable-tag-pill ${getTagColorClass(tag)}`;
    chip.textContent = tag;
    chip.onclick = () => {
      if (batchSelectedModalTags.has(tag)) {
        batchSelectedModalTags.delete(tag);
        chip.classList.remove("selected");
      } else {
        batchSelectedModalTags.add(tag);
        chip.classList.add("selected");
      }
    };
    batchModalTagsList.appendChild(chip);
  }
}

async function submitBatchTags() {
  if (!currentProjectId || selectedVideoIds.size === 0) return;

  let tagsToApply = Array.from(batchSelectedModalTags);
  const inputVal = batchTagInput.value.trim().toLowerCase().replace(/\s+/g, "-");
  if (inputVal && batchTagMode === "add" && !tagsToApply.includes(inputVal)) {
    tagsToApply.push(inputVal);
  }

  if (tagsToApply.length === 0) {
    await showAlertDialog("Selecione ou digite ao menos uma tag para aplicar aos vídeos selecionados.", "Atenção");
    return;
  }

  const paths = getSelectedVideoPaths();

  try {
    if (batchTagMode === "add") {
      await invoke("batch_add_tags", {
        projectId: currentProjectId,
        videoPaths: paths,
        tagsToAdd: tagsToApply,
      });

      tagsToApply.forEach((t) => {
        if (!availableProjectTags.includes(t)) availableProjectTags.push(t);
      });

      allVideos.forEach((v) => {
        if (selectedVideoIds.has(v.id)) {
          tagsToApply.forEach((t) => {
            if (!v.tags.includes(t)) v.tags.push(t);
          });
        }
      });
    } else {
      await invoke("batch_remove_tags", {
        projectId: currentProjectId,
        videoPaths: paths,
        tagsToRemove: tagsToApply,
      });

      allVideos.forEach((v) => {
        if (selectedVideoIds.has(v.id)) {
          v.tags = v.tags.filter((t) => !tagsToApply.includes(t));
        }
      });
    }

    batchTagsModal.classList.add("hidden");
    clearBatchSelection();
    renderTagFilters();
    renderGrid();
  } catch (err) {
    await showAlertDialog(`Erro ao processar tags em lote: ${err}`, "Erro ao Processar Tags");
  }
}

// ============================================================
// MOVER PARA A LIXEIRA DO WINDOWS
// ============================================================
async function handleMoveVideosToTrash(videoPaths: string[]) {
  if (!currentProjectId || videoPaths.length === 0) return;

  const count = videoPaths.length;
  const sampleName = videoPaths[0].split(/[\\/]/).pop() || videoPaths[0];
  const msg =
    count === 1
      ? `Deseja mover o arquivo "${sampleName}" para a Lixeira do Windows?\n\nEle poderá ser restaurado pela Lixeira se necessário.`
      : `Deseja mover ${count} arquivos de vídeo selecionados para a Lixeira do Windows?\n\nEles poderão ser restaurados pela Lixeira caso necessário.`;

  const confirmed = await showConfirmDialog({
    title: "Mover para a Lixeira",
    message: msg,
    confirmText: "Mover para Lixeira",
    cancelText: "Cancelar",
    danger: true,
    type: "danger",
  });

  if (!confirmed) return;

  try {
    const deleted = await invoke<string[]>("move_videos_to_trash", {
      projectId: currentProjectId,
      videoPaths,
    });

    const deletedSet = new Set(deleted);
    allVideos = allVideos.filter((v) => !deletedSet.has(v.path));
    const remainingIds = new Set(allVideos.map((v) => v.id));
    for (const id of Array.from(selectedVideoIds)) {
      if (!remainingIds.has(id)) selectedVideoIds.delete(id);
    }

    clearBatchSelection();
    renderGrid();
    renderSidebarFolders();
    renderTagFilters();

    const totalSize = allVideos.reduce((acc, v) => acc + v.size_bytes, 0);
    statsBadge.textContent = `${allVideos.length} vídeos • ${formatFileSize(totalSize)}`;
  } catch (err) {
    await showAlertDialog(`Erro ao mover para a Lixeira: ${err}`, "Erro na Lixeira");
  }
}

// ============================================================
// MOVER / COPIAR ARQUIVOS ENTRE PASTAS
// ============================================================
function openMoveCopyModal(videoPaths: string[], isMove: boolean) {
  if (!currentProjectId || videoPaths.length === 0) return;
  moveCopyTargetPaths = videoPaths;
  moveCopyIsMove = isMove;
  moveCopySelectedFolder = null;

  if (moveCopyTitle) {
    moveCopyTitle.textContent = isMove ? "Mover Arquivo(s)" : "Copiar Arquivo(s)";
  }
  if (moveCopyDesc) {
    moveCopyDesc.textContent = isMove
      ? `Selecione a pasta de destino para mover ${videoPaths.length} arquivo(s):`
      : `Selecione a pasta de destino para copiar ${videoPaths.length} arquivo(s):`;
  }
  if (moveCopyBtnConfirm) {
    moveCopyBtnConfirm.textContent = isMove ? "Confirmar e Mover" : "Confirmar e Copiar";
    moveCopyBtnConfirm.disabled = true;
  }
  if (moveCopyDestLabel) {
    moveCopyDestLabel.textContent = "Nenhuma selecionada";
  }

  renderMoveCopyFolders();
  moveCopyModal?.classList.remove("hidden");
}

function renderMoveCopyFolders() {
  if (!moveCopyFoldersList) return;
  moveCopyFoldersList.innerHTML = "";

  if (currentProjectFolders.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:0.75rem; color:var(--text-muted); padding:0.5rem;";
    empty.textContent = "Nenhuma pasta vinculada neste projeto. Use o botão abaixo para escolher uma pasta no disco.";
    moveCopyFoldersList.appendChild(empty);
    return;
  }

  for (const folder of currentProjectFolders) {
    const row = document.createElement("div");
    row.className = `move-folder-item ${moveCopySelectedFolder === folder ? "selected" : ""}`;
    row.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;color:var(--accent-primary);flex-shrink:0;"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
    `;

    row.onclick = () => {
      moveCopySelectedFolder = folder;
      if (moveCopyDestLabel) moveCopyDestLabel.textContent = folder;
      if (moveCopyBtnConfirm) moveCopyBtnConfirm.disabled = false;
      renderMoveCopyFolders();
    };

    moveCopyFoldersList.appendChild(row);
  }
}

async function handleBrowseMoveCopyFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Selecione a Pasta de Destino",
    });

    if (selected && typeof selected === "string") {
      moveCopySelectedFolder = selected;
      if (moveCopyDestLabel) moveCopyDestLabel.textContent = selected;
      if (moveCopyBtnConfirm) moveCopyBtnConfirm.disabled = false;
      renderMoveCopyFolders();
    }
  } catch (err) {
    console.error("Erro ao selecionar pasta:", err);
  }
}

async function executeMoveOrCopy() {
  if (!currentProjectId || !moveCopySelectedFolder || moveCopyTargetPaths.length === 0) return;

  try {
    const res = await invoke<FileOperationResult>("move_or_copy_videos", {
      projectId: currentProjectId,
      videoPaths: moveCopyTargetPaths,
      destFolder: moveCopySelectedFolder,
      isMove: moveCopyIsMove,
    });

    moveCopyModal?.classList.add("hidden");
    clearBatchSelection();

    // Sincroniza e recarrega os vídeos do projeto
    await switchProject(currentProjectId);

    if (res.failed_paths.length > 0) {
      await showAlertDialog(
        `Operação concluída com avisos:\nSucesso: ${res.success_paths.length}\nFalhas: ${res.failed_paths.length}\n${res.failed_paths.map(([p, e]) => `${p}: ${e}`).join("\n")}`,
        "Resultado da Operação"
      );
    }
  } catch (err) {
    await showAlertDialog(`Erro ao realizar operação: ${err}`, "Erro");
  }
}

// ============================================================
// LOCALIZADOR DE VÍDEOS DUPLICADOS
// ============================================================
function openDuplicatesModal() {
  if (!currentProjectId) {
    showAlertDialog("Selecione ou crie um projeto primeiro.", "Nenhum Projeto Ativo");
    return;
  }
  duplicatesModal?.classList.remove("hidden");
  if (duplicatesResultsContainer && duplicatesEmptyHint) {
    duplicatesResultsContainer.innerHTML = "";
    duplicatesResultsContainer.appendChild(duplicatesEmptyHint);
  }
  duplicatesSummaryBanner?.classList.add("hidden");
}

async function scanProjectDuplicates() {
  if (!currentProjectId || !btnScanDuplicates || !duplicatesResultsContainer) return;
  const criteria = duplicatesCriteriaSelect?.value || "content";

  btnScanDuplicates.disabled = true;
  btnScanDuplicates.innerHTML = `<span>Escaneando...</span>`;
  duplicatesResultsContainer.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-size:0.85rem;">Analisando arquivos e calculando assinaturas...</div>`;

  try {
    const groups = await invoke<DuplicateGroup[]>("find_project_duplicates", {
      projectId: currentProjectId,
      criteria,
    });

    btnScanDuplicates.disabled = false;
    btnScanDuplicates.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px;"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <span>Escanear Projeto</span>
    `;

    renderDuplicateResults(groups);
  } catch (err) {
    btnScanDuplicates.disabled = false;
    btnScanDuplicates.innerHTML = `<span>Escanear Projeto</span>`;
    duplicatesResultsContainer.innerHTML = `<div style="text-align:center; padding:2rem; color:#ef4444; font-size:0.85rem;">Erro ao escanear: ${err}</div>`;
  }
}

function renderDuplicateResults(groups: DuplicateGroup[]) {
  if (!duplicatesResultsContainer) return;
  duplicatesResultsContainer.innerHTML = "";

  const totalGroups = groups.length;
  const totalFiles = groups.reduce((acc, g) => acc + g.items.length, 0);
  const wastedBytes = groups.reduce((acc, g) => {
    const singleSize = g.items[0]?.size_bytes || 0;
    return acc + singleSize * (g.items.length - 1);
  }, 0);

  if (duplicatesSummaryBanner && duplicatesSummaryText) {
    duplicatesSummaryBanner.classList.remove("hidden");
    if (totalGroups === 0) {
      duplicatesSummaryText.textContent = "Nenhum arquivo duplicado foi encontrado com o critério selecionado!";
    } else {
      duplicatesSummaryText.innerHTML = `
        <span><strong>${totalGroups}</strong> grupos duplicados (<strong>${totalFiles}</strong> arquivos no total)</span>
        <span style="color:var(--accent-primary); font-weight:600;">Espaço recuperável: ${formatFileSize(wastedBytes)}</span>
      `;
    }
  }

  if (totalGroups === 0) {
    duplicatesResultsContainer.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem; color:var(--text-muted); font-size:0.85rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:36px;height:36px;color:#10b981;margin-bottom:0.5rem;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <br/>Parabéns! Nenhum vídeo duplicado foi detectado neste projeto.
      </div>
    `;
    return;
  }

  for (let idx = 0; idx < groups.length; idx++) {
    const group = groups[idx];
    const groupCard = document.createElement("div");
    groupCard.className = "dup-group-card";

    const header = document.createElement("div");
    header.className = "dup-group-header";
    header.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-weight:700; color:var(--accent-primary);">Grupo #${idx + 1}</span>
        <span class="nav-counter-pill">${group.items.length} cópias</span>
        <span style="font-family:var(--font-mono); color:var(--text-secondary); font-size:0.73rem;">${formatFileSize(group.items[0]?.size_bytes || 0)} cada</span>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <button class="dup-action-btn" title="Manter apenas o mais recente e enviar os outros para a Lixeira">
          Manter Mais Recente
        </button>
      </div>
    `;

    const keepRecentBtn = header.querySelector("button");
    if (keepRecentBtn) {
      keepRecentBtn.onclick = async () => {
        const sorted = [...group.items].sort((a, b) => b.modified - a.modified);
        const toTrash = sorted.slice(1).map((v) => v.path);
        if (toTrash.length > 0) {
          await handleMoveVideosToTrash(toTrash);
          scanProjectDuplicates();
        }
      };
    }

    const rowsWrap = document.createElement("div");
    rowsWrap.className = "dup-group-items";

    for (const item of group.items) {
      const row = document.createElement("div");
      row.className = "dup-file-row";

      const thumb = document.createElement("div");
      thumb.className = "dup-file-thumb";
      if (item.thumbnail) {
        thumb.innerHTML = `<img src="${convertFileSrc(item.thumbnail)}" loading="lazy" />`;
      } else {
        thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px;color:var(--text-muted);"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/></svg>`;
      }

      const info = document.createElement("div");
      info.className = "dup-file-info";
      info.innerHTML = `
        <div class="dup-file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="dup-file-meta">
          <span>📁 ${escapeHtml(item.folder_origin || "Avulso")}</span>
          <span>•</span>
          <span>${formatFileSize(item.size_bytes)}</span>
          <span>•</span>
          <span>Modificado: ${formatDate(item.modified)}</span>
          <span>•</span>
          <span>👁 ${item.play_count || 0} plays</span>
        </div>
      `;

      const actions = document.createElement("div");
      actions.className = "dup-file-actions";
      actions.innerHTML = `
        <button class="dup-action-btn btn-play" title="Reproduzir este vídeo">▶</button>
        <button class="dup-action-btn btn-explore" title="Mostrar no Windows Explorer">📁</button>
        <button class="dup-action-btn danger btn-trash" title="Mover este arquivo para a Lixeira">🗑 Lixeira</button>
      `;

      actions.querySelector(".btn-play")?.addEventListener("click", () => playVideo(item.path));
      actions.querySelector(".btn-explore")?.addEventListener("click", () => invoke("open_in_explorer", { videoPath: item.path }));
      actions.querySelector(".btn-trash")?.addEventListener("click", async () => {
        await handleMoveVideosToTrash([item.path]);
        scanProjectDuplicates();
      });

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      rowsWrap.appendChild(row);
    }

    groupCard.appendChild(header);
    groupCard.appendChild(rowsWrap);
    duplicatesResultsContainer.appendChild(groupCard);
  }
}

// ============================================================
// MENU DE CONTEXTO NOTION (BOTÃO DIREITO)
// ============================================================
function openContextMenu(e: MouseEvent, video: VideoItem) {
  closeViewContextMenu();
  contextTargetVideo = video;

  ctxFavLabel.textContent = video.is_favorite ? "Remover dos favoritos" : "Favoritar";
  ctxFavIcon.textContent = video.is_favorite ? "☆" : "★";

  // Renderiza as tags dinamicamente no submenu
  renderContextTagsSubmenu(video);

  contextMenu.classList.remove("hidden");

  // Mede as dimensões reais do menu após ser exibido para evitar cortes na borda inferior da tela
  const rect = contextMenu.getBoundingClientRect();
  const menuWidth = rect.width > 0 ? rect.width : (contextMenu.offsetWidth || 220);
  const menuHeight = rect.height > 0 ? rect.height : (contextMenu.offsetHeight || 420);
  const submenuWidth = 240;
  const winWidth = window.innerWidth;
  const winHeight = window.innerHeight;

  let x = e.clientX;
  let y = e.clientY;

  // Se o submenu estourar a tela à direita, abre para a esquerda
  if (x + menuWidth + submenuWidth > winWidth) {
    contextMenu.classList.add("submenu-open-left");
  } else {
    contextMenu.classList.remove("submenu-open-left");
  }

  if (x + menuWidth > winWidth) x = Math.max(10, winWidth - menuWidth - 10);
  if (y + menuHeight > winHeight) y = Math.max(10, winHeight - menuHeight - 10);

  contextMenu.style.left = `${Math.round(x)}px`;
  contextMenu.style.top = `${Math.round(y)}px`;

  // Ajusta a posição de todos os submenus para não cortarem na borda inferior da tela
  contextMenu.querySelectorAll<HTMLElement>(".context-menu-item.has-submenu").forEach((item) => {
    adjustSubmenuPosition(item);
  });
}

function renderContextTagsSubmenu(video: VideoItem) {
  if (!ctxTagsSubmenuList) return;
  ctxTagsSubmenuList.innerHTML = "";

  if (availableProjectTags.length === 0) {
    const empty = document.createElement("div");
    empty.className = "context-submenu-empty";
    empty.textContent = "Nenhuma tag no projeto ainda";
    ctxTagsSubmenuList.appendChild(empty);
    return;
  }

  for (const tag of availableProjectTags) {
    const isChecked = video.tags.includes(tag);
    const row = document.createElement("div");
    row.className = `context-submenu-tag-row ${isChecked ? "active" : ""}`;
    row.title = isChecked ? `Desmarcar #${tag}` : `Marcar #${tag}`;

    row.innerHTML = `
      <span class="ctx-tag-checkbox">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <span class="ctx-tag-label-pill">#${escapeHtml(tag)}</span>
    `;

    row.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleVideoTagDirectly(video, tag);
    });

    ctxTagsSubmenuList.appendChild(row);
  }
}

async function toggleVideoTagDirectly(video: VideoItem, tag: string) {
  if (!currentProjectId) return;

  const idx = video.tags.indexOf(tag);
  if (idx !== -1) {
    video.tags.splice(idx, 1);
  } else {
    video.tags.push(tag);
  }

  try {
    await invoke("set_video_tags", {
      projectId: currentProjectId,
      videoPath: video.path,
      tags: video.tags,
    });

    renderContextTagsSubmenu(video);
    renderGrid();
    renderTagFilters();
    updateUIIndicators(allVideos.length);
  } catch (err) {
    console.error("Erro ao alternar tag:", err);
  }
}

async function createAndApplyTagDirectly(video: VideoItem, rawTag: string) {
  const cleanTag = rawTag.trim().toLowerCase().replace(/^[#\s]+/, "");
  if (!cleanTag || !currentProjectId) return;

  if (!availableProjectTags.includes(cleanTag)) {
    availableProjectTags.push(cleanTag);
  }
  if (!video.tags.includes(cleanTag)) {
    video.tags.push(cleanTag);
  }

  try {
    await invoke("set_video_tags", {
      projectId: currentProjectId,
      videoPath: video.path,
      tags: video.tags,
    });

    if (ctxQuickTagInput) ctxQuickTagInput.value = "";
    renderContextTagsSubmenu(video);
    renderGrid();
    renderTagFilters();
    updateUIIndicators(allVideos.length);
  } catch (err) {
    console.error("Erro ao criar tag:", err);
  }
}

let submenuGraceTimer: number | null = null;
let currentOpenSubmenuItem: HTMLElement | null = null;

function closeContextMenu() {
  contextMenu.classList.add("hidden");
  contextTargetVideo = null;
  document.querySelectorAll(".context-menu-item.submenu-open").forEach((el) => {
    el.classList.remove("submenu-open");
  });
  if (submenuGraceTimer) {
    clearTimeout(submenuGraceTimer);
    submenuGraceTimer = null;
  }
  currentOpenSubmenuItem = null;
}

// ============================================================
// MENU DE CONTEXTO DA ÁREA DE TRABALHO / VISUALIZAÇÃO
// ============================================================
function toggleSortByField(field: string) {
  switch (field) {
    case "name":
      setSortMode(currentSortMode === "name-asc" ? "name-desc" : "name-asc");
      break;
    case "date":
      setSortMode(currentSortMode === "date-desc" ? "date-asc" : "date-desc");
      break;
    case "size":
      setSortMode(currentSortMode === "size-desc" ? "size-asc" : "size-desc");
      break;
    case "duration":
      setSortMode(currentSortMode === "duration-desc" ? "duration-asc" : "duration-desc");
      break;
    case "plays":
      setSortMode(currentSortMode === "plays-desc" ? "plays-asc" : "plays-desc");
      break;
    case "recent-played":
      setSortMode("recent-played");
      break;
  }
}

function updateViewContextMenuState() {
  if (!viewContextMenu) return;

  // 1. Modo de Exibição
  const checkModeGrid = document.getElementById("vctx-check-mode-grid");
  const checkModeTable = document.getElementById("vctx-check-mode-table");
  if (checkModeGrid) checkModeGrid.textContent = currentViewMode === "grid" ? "✓" : "";
  if (checkModeTable) checkModeTable.textContent = currentViewMode === "table" ? "✓" : "";

  // 2. Tamanho dos Cards
  const checkSmall = document.getElementById("vctx-check-size-small");
  const checkMedium = document.getElementById("vctx-check-size-medium");
  const checkLarge = document.getElementById("vctx-check-size-large");
  if (checkSmall) checkSmall.textContent = currentGridSize === "small" ? "✓" : "";
  if (checkMedium) checkMedium.textContent = currentGridSize === "medium" ? "✓" : "";
  if (checkLarge) checkLarge.textContent = currentGridSize === "large" ? "✓" : "";

  // 3. Agrupamento
  const groups: GroupByMode[] = ["none", "folder", "tag", "date", "format", "status"];
  for (const g of groups) {
    const el = document.getElementById(`vctx-check-group-${g}`);
    if (el) el.textContent = currentGroupBy === g ? "✓" : "";
  }

  // 4. Ordenação
  const sortFields = ["name", "date", "size", "duration", "plays", "recent-played"];
  for (const f of sortFields) {
    const checkEl = document.getElementById(`vctx-check-sort-${f}`);
    const arrowEl = document.getElementById(`vctx-arrow-sort-${f}`);
    if (checkEl) checkEl.textContent = "";
    if (arrowEl) arrowEl.textContent = "";
  }

  if (currentSortMode === "name-asc") {
    const check = document.getElementById("vctx-check-sort-name");
    const arrow = document.getElementById("vctx-arrow-sort-name");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "A → Z";
  } else if (currentSortMode === "name-desc") {
    const check = document.getElementById("vctx-check-sort-name");
    const arrow = document.getElementById("vctx-arrow-sort-name");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Z → A";
  } else if (currentSortMode === "date-desc") {
    const check = document.getElementById("vctx-check-sort-date");
    const arrow = document.getElementById("vctx-arrow-sort-date");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Mais Recentes";
  } else if (currentSortMode === "date-asc") {
    const check = document.getElementById("vctx-check-sort-date");
    const arrow = document.getElementById("vctx-arrow-sort-date");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Mais Antigos";
  } else if (currentSortMode === "size-desc") {
    const check = document.getElementById("vctx-check-sort-size");
    const arrow = document.getElementById("vctx-arrow-sort-size");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Maior";
  } else if (currentSortMode === "size-asc") {
    const check = document.getElementById("vctx-check-sort-size");
    const arrow = document.getElementById("vctx-arrow-sort-size");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Menor";
  } else if (currentSortMode === "duration-desc") {
    const check = document.getElementById("vctx-check-sort-duration");
    const arrow = document.getElementById("vctx-arrow-sort-duration");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Mais Longos";
  } else if (currentSortMode === "duration-asc") {
    const check = document.getElementById("vctx-check-sort-duration");
    const arrow = document.getElementById("vctx-arrow-sort-duration");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Mais Curtos";
  } else if (currentSortMode === "plays-desc") {
    const check = document.getElementById("vctx-check-sort-plays");
    const arrow = document.getElementById("vctx-arrow-sort-plays");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Mais Assistidos";
  } else if (currentSortMode === "plays-asc") {
    const check = document.getElementById("vctx-check-sort-plays");
    const arrow = document.getElementById("vctx-arrow-sort-plays");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Nunca Assistidos";
  } else if (currentSortMode === "recent-played") {
    const check = document.getElementById("vctx-check-sort-recent-played");
    const arrow = document.getElementById("vctx-arrow-sort-recent-played");
    if (check) check.textContent = "✓";
    if (arrow) arrow.textContent = "Recentes";
  }
}

function openViewContextMenu(e: MouseEvent) {
  if (!viewContextMenu) return;
  closeContextMenu();

  updateViewContextMenuState();
  viewContextMenu.classList.remove("hidden");

  const rect = viewContextMenu.getBoundingClientRect();
  const menuWidth = rect.width > 0 ? rect.width : (viewContextMenu.offsetWidth || 210);
  const menuHeight = rect.height > 0 ? rect.height : (viewContextMenu.offsetHeight || 220);
  const submenuWidth = 250;
  const winWidth = window.innerWidth;
  const winHeight = window.innerHeight;

  let x = e.clientX;
  let y = e.clientY;

  // Se o submenu estourar a tela à direita, abre para a esquerda
  if (x + menuWidth + submenuWidth > winWidth) {
    viewContextMenu.classList.add("submenu-open-left");
  } else {
    viewContextMenu.classList.remove("submenu-open-left");
  }

  if (x + menuWidth > winWidth) x = Math.max(10, winWidth - menuWidth - 10);
  if (y + menuHeight > winHeight) y = Math.max(10, winHeight - menuHeight - 10);

  viewContextMenu.style.left = `${Math.round(x)}px`;
  viewContextMenu.style.top = `${Math.round(y)}px`;

  // Ajusta a posição de todos os submenus para não cortarem na borda inferior da tela
  viewContextMenu.querySelectorAll<HTMLElement>(".context-menu-item.has-submenu").forEach((item) => {
    adjustSubmenuPosition(item);
  });
}

function closeViewContextMenu() {
  if (viewContextMenu) viewContextMenu.classList.add("hidden");
  document.querySelectorAll(".context-menu-item.submenu-open").forEach((el) => {
    el.classList.remove("submenu-open");
  });
  if (submenuGraceTimer) {
    clearTimeout(submenuGraceTimer);
    submenuGraceTimer = null;
  }
  currentOpenSubmenuItem = null;
}

function initViewContextMenu() {
  if (!viewContextMenu) return;

  // 1. Modo de exibição
  document.getElementById("vctx-mode-grid")?.addEventListener("click", () => {
    setViewMode("grid");
    closeViewContextMenu();
  });
  document.getElementById("vctx-mode-table")?.addEventListener("click", () => {
    setViewMode("table");
    closeViewContextMenu();
  });

  // 2. Tamanho dos cards
  viewContextMenu.querySelectorAll("[data-vctx-size]").forEach((item) => {
    item.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement;
      const size = el.getAttribute("data-vctx-size") as "small" | "medium" | "large";
      if (size) setGridSize(size);
      closeViewContextMenu();
    });
  });

  // 3. Ordenação com alternância dinâmica
  viewContextMenu.querySelectorAll("[data-vctx-sort]").forEach((item) => {
    item.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement;
      const sortField = el.getAttribute("data-vctx-sort");
      if (sortField) {
        toggleSortByField(sortField);
        updateViewContextMenuState();
      }
      closeViewContextMenu();
    });
  });

  // 4. Agrupar por
  viewContextMenu.querySelectorAll("[data-vctx-group]").forEach((item) => {
    item.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement;
      const group = el.getAttribute("data-vctx-group") as GroupByMode;
      if (group) setGroupBy(group);
      closeViewContextMenu();
    });
  });

  // 5. Ações rápidas de sincronização e sorteio
  document.getElementById("vctx-sync-action")?.addEventListener("click", () => {
    closeViewContextMenu();
    handleSyncProject();
  });

  document.getElementById("vctx-random-action")?.addEventListener("click", () => {
    closeViewContextMenu();
    openRandomModal();
  });

  // 6. Configura tolerância e suavidade ao passar o mouse entre menus e submenus
  setupSubmenuHoverGrace();
}

function adjustSubmenuPosition(item: HTMLElement) {
  const submenu = item.querySelector<HTMLElement>(".context-submenu");
  if (!submenu) return;

  // Se o submenu estiver oculto (display: none), realiza medição rápida em offscreen
  let measuredHeight = submenu.offsetHeight;
  if (!measuredHeight || measuredHeight === 0) {
    const prevDisplay = submenu.style.display;
    const prevVisibility = submenu.style.visibility;
    submenu.style.visibility = "hidden";
    submenu.style.display = "flex";
    measuredHeight = submenu.offsetHeight || submenu.scrollHeight || 260;
    submenu.style.display = prevDisplay;
    submenu.style.visibility = prevVisibility;
  }

  const itemRect = item.getBoundingClientRect();
  const submenuHeight = measuredHeight || 260;
  const winHeight = window.innerHeight;

  const expectedBottom = itemRect.top + submenuHeight;
  const maxBottom = winHeight - 12;

  if (expectedBottom > maxBottom) {
    const overflow = expectedBottom - maxBottom;
    let newTop = -4 - overflow;

    // Se ao subir passar do topo da janela (em janelas pequenas)
    if (itemRect.top + newTop < 12) {
      newTop = 12 - itemRect.top;
      submenu.style.maxHeight = `${winHeight - 24}px`;
      submenu.style.overflowY = "auto";
    } else {
      submenu.style.maxHeight = "";
      submenu.style.overflowY = "";
    }

    submenu.style.top = `${Math.round(newTop)}px`;
  } else {
    submenu.style.top = "-4px";
    submenu.style.maxHeight = "";
    submenu.style.overflowY = "";
  }
}

function setupSubmenuHoverGrace() {
  document.querySelectorAll<HTMLElement>(".context-menu-item.has-submenu").forEach((item) => {
    const submenu = item.querySelector<HTMLElement>(".context-submenu");

    item.addEventListener("mouseenter", () => {
      adjustSubmenuPosition(item);
      if (submenuGraceTimer) {
        clearTimeout(submenuGraceTimer);
        submenuGraceTimer = null;
      }
      if (currentOpenSubmenuItem && currentOpenSubmenuItem !== item) {
        currentOpenSubmenuItem.classList.remove("submenu-open");
      }
      currentOpenSubmenuItem = item;
      item.classList.add("submenu-open");
    });

    item.addEventListener("mouseleave", () => {
      if (submenuGraceTimer) clearTimeout(submenuGraceTimer);
      submenuGraceTimer = window.setTimeout(() => {
        item.classList.remove("submenu-open");
        if (currentOpenSubmenuItem === item) currentOpenSubmenuItem = null;
      }, 300);
    });

    if (submenu) {
      submenu.addEventListener("mouseenter", () => {
        adjustSubmenuPosition(item);
        if (submenuGraceTimer) {
          clearTimeout(submenuGraceTimer);
          submenuGraceTimer = null;
        }
        item.classList.add("submenu-open");
      });

      submenu.addEventListener("mouseleave", () => {
        if (submenuGraceTimer) clearTimeout(submenuGraceTimer);
        submenuGraceTimer = window.setTimeout(() => {
          item.classList.remove("submenu-open");
          if (currentOpenSubmenuItem === item) currentOpenSubmenuItem = null;
        }, 300);
      });
    }

    // Permite clicar no item pai para manter ou alternar o submenu aberto
    item.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".context-submenu")) {
        e.stopPropagation();
        adjustSubmenuPosition(item);
        item.classList.toggle("submenu-open");
      }
    });
  });
}

// ============================================================
// MODAL DE SORTEIO ALEATÓRIO (SHUFFLE AVANÇADO)
// ============================================================
function openRandomModal() {
  if (allVideos.length === 0) {
    showAlertDialog("Adicione vídeos ao seu projeto antes de sortear!", "Sorteio Aleatório");
    return;
  }
  if (randomTitleInput) {
    randomTitleInput.value = randomTitleFilter;
  }
  renderRandomModalTagPickers();
  updateRandomModalMatchingCount();
  randomModal.classList.remove("hidden");
  if (randomTitleInput) {
    randomTitleInput.focus();
    randomTitleInput.select();
  }
}

function closeRandomModal() {
  randomModal.classList.add("hidden");
}

function renderRandomModalTagPickers() {
  randomIncludeTagsContainer.innerHTML = "";
  randomExcludeTagsContainer.innerHTML = "";

  if (availableProjectTags.length === 0) {
    const emptySpan1 = document.createElement("span");
    emptySpan1.className = "section-hint";
    emptySpan1.textContent = "Nenhuma tag cadastrada neste projeto.";
    randomIncludeTagsContainer.appendChild(emptySpan1);

    const emptySpan2 = document.createElement("span");
    emptySpan2.className = "section-hint";
    emptySpan2.textContent = "Nenhuma tag cadastrada neste projeto.";
    randomExcludeTagsContainer.appendChild(emptySpan2);
    return;
  }

  for (const tag of availableProjectTags) {
    const colorClass = getTagColorClass(tag);

    const incBtn = document.createElement("button");
    incBtn.className = `selectable-tag-pill ${colorClass} ${randomIncludeTags.has(tag) ? "selected" : ""}`;
    incBtn.textContent = tag;
    incBtn.onclick = () => {
      if (randomIncludeTags.has(tag)) {
        randomIncludeTags.delete(tag);
      } else {
        randomIncludeTags.add(tag);
        randomExcludeTags.delete(tag);
      }
      renderRandomModalTagPickers();
      updateRandomModalMatchingCount();
    };
    randomIncludeTagsContainer.appendChild(incBtn);

    const excBtn = document.createElement("button");
    excBtn.className = `selectable-tag-pill ${colorClass} ${randomExcludeTags.has(tag) ? "selected" : ""}`;
    excBtn.textContent = `não #${tag}`;
    excBtn.onclick = () => {
      if (randomExcludeTags.has(tag)) {
        randomExcludeTags.delete(tag);
      } else {
        randomExcludeTags.add(tag);
        randomIncludeTags.delete(tag);
      }
      renderRandomModalTagPickers();
      updateRandomModalMatchingCount();
    };
    randomExcludeTagsContainer.appendChild(excBtn);
  }
}

function getMatchingRandomVideos(): VideoItem[] {
  return allVideos.filter((video) => {
    if (randomFavMode === "only_fav" && !video.is_favorite) return false;
    if (randomFavMode === "not_fav" && video.is_favorite) return false;

    if (randomTitleFilter.trim()) {
      const words = normalizeSearchText(randomTitleFilter).split(/\s+/).filter(Boolean);
      const videoName = normalizeSearchText(video.name);
      for (const word of words) {
        if (!videoName.includes(word)) return false;
      }
    }

    for (const incTag of randomIncludeTags) {
      if (!video.tags.includes(incTag)) return false;
    }

    for (const excTag of randomExcludeTags) {
      if (video.tags.includes(excTag)) return false;
    }

    return true;
  });
}

function updateRandomModalMatchingCount() {
  const matching = getMatchingRandomVideos();
  randomMatchingCount.textContent = matching.length.toString();
  btnExecuteRandomPlay.disabled = matching.length === 0;
}

function executeRandomPlay() {
  const eligible = getMatchingRandomVideos();
  if (eligible.length === 0) {
    showAlertDialog("Nenhum vídeo corresponde aos filtros configurados para o sorteio!", "Sorteio Aleatório");
    return;
  }

  const randomIndex = Math.floor(Math.random() * eligible.length);
  const pickedVideo = eligible[randomIndex];

  closeRandomModal();

  const cardEl = document.querySelector(`.notion-card[data-id="${pickedVideo.id}"]`) as HTMLElement;
  if (cardEl) {
    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
    cardEl.classList.add("selected-highlight");
    setTimeout(() => {
      cardEl.classList.remove("selected-highlight");
    }, 2800);
  }

  playVideo(pickedVideo.path);
}

// ============================================================
// FILTROS DA TOOLBAR
// ============================================================
function renderTagFilters() {
  tagFilterList.innerHTML = "";

  if (availableProjectTags.length === 0) {
    const emptySpan = document.createElement("span");
    emptySpan.style.fontSize = "0.72rem";
    emptySpan.style.color = "var(--text-muted)";
    emptySpan.style.padding = "0.3rem 0.5rem";
    emptySpan.textContent = "Nenhuma tag no projeto";
    tagFilterList.appendChild(emptySpan);
    return;
  }

  for (const tag of availableProjectTags) {
    const chip = document.createElement("div");
    const isIncluded = selectedFilterTags.has(tag);
    const isExcluded = excludedFilterTags.has(tag);
    chip.className = `sidebar-tag-chip ${isIncluded ? "active" : ""} ${isExcluded ? "excluded" : ""}`;
    chip.title = isExcluded
      ? `Tag NEGADA: vídeos com #${tag} estão ocultos. Botão direito para desmarcar.`
      : isIncluded
      ? `Tag ATIVA: vídeos com #${tag} são exibidos. Botão esquerdo para desmarcar, botão direito para torná-la negativa.`
      : `Botão esquerdo para filtrar por #${tag}. Botão direito para marcar como negativa (ocultar vídeos com esta tag).`;

    const colorClass = getTagColorClass(tag);
    const count = allVideos.filter((v) => v.tags.includes(tag)).length;

    chip.innerHTML = `
      <span class="sidebar-tag-dot ${colorClass}"></span>
      <span class="sidebar-tag-label">${escapeHtml(tag)}</span>
      <span class="sidebar-tag-count">${count}</span>
      <button class="tag-chip-del" title="Excluir tag do projeto">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;

    const delBtn = chip.querySelector(".tag-chip-del") as HTMLButtonElement | null;
    if (delBtn) {
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!currentProjectId) return;
        const confirmed = await showConfirmDialog({
          title: "Excluir Tag",
          message: `Deseja remover a tag "${tag}" do projeto? Ela será desvinculada de todos os vídeos deste projeto.`,
          confirmText: "Excluir Tag",
          danger: true,
        });
        if (!confirmed) return;
        try {
          const updatedTags = await invoke<string[]>("remove_project_tag", {
            projectId: currentProjectId,
            tag,
          });
          availableProjectTags = updatedTags;
          selectedFilterTags.delete(tag);
          excludedFilterTags.delete(tag);
          allVideos.forEach((v) => {
            v.tags = v.tags.filter((t) => t !== tag);
          });
          renderTagFilters();
          renderGrid();
        } catch (err) {
          showAlertDialog(`Erro ao remover tag: ${err}`, "Erro");
        }
      };
    }

    chip.onclick = () => {
      filterOnlyFavorites = false;
      filterOnlyUntagged = false;
      // Clique esquerdo: alterna apenas entre ativa (incluída) e normal
      if (selectedFilterTags.has(tag)) {
        selectedFilterTags.delete(tag);
      } else {
        excludedFilterTags.delete(tag);
        selectedFilterTags.add(tag);
      }
      renderTagFilters();
      renderGrid();
    };

    chip.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      filterOnlyFavorites = false;
      filterOnlyUntagged = false;
      // Clique direito: alterna diretamente entre negativa (vermelha) e normal
      if (excludedFilterTags.has(tag)) {
        excludedFilterTags.delete(tag);
      } else {
        selectedFilterTags.delete(tag);
        excludedFilterTags.add(tag);
      }
      renderTagFilters();
      renderGrid();
    };

    tagFilterList.appendChild(chip);
  }
}

function updateCardInDom(video: VideoItem) {
  const cardEl = document.querySelector(`.notion-card[data-id="${video.id}"]`);
  if (!cardEl) return;
  const mediaWrapper = cardEl.querySelector(".card-media-wrapper") as HTMLElement | null;
  if (!mediaWrapper) return;

  const fallback = mediaWrapper.querySelector(".card-media-fallback");
  if (fallback) fallback.remove();

  let img = mediaWrapper.querySelector(".card-media-img") as HTMLImageElement;
  if (!img) {
    img = document.createElement("img");
    img.className = "card-media-img";
    img.loading = "lazy";
    img.alt = video.name;
    mediaWrapper.prepend(img);
  }
  if (video.thumbnail) {
    img.src = convertFileSrc(video.thumbnail);
  }

  if (video.duration_secs > 0) {
    let durBadge = mediaWrapper.querySelector(".card-duration-badge");
    if (!durBadge) {
      durBadge = document.createElement("div");
      durBadge.className = "card-duration-badge";
      mediaWrapper.appendChild(durBadge);
    }
    durBadge.textContent = formatDuration(video.duration_secs);
  }
}

// ============================================================
// GERAÇÃO DE THUMBNAILS & DURAÇÕES (PARALELO & CONTROLÁVEL)
// ============================================================
async function startBackgroundThumbnailGeneration(forceRestart = false) {
  if (!currentProjectId) return;
  if (isQueueRunning && !forceRestart) return;

  thumbQueueSessionId++;
  const thisSessionId = thumbQueueSessionId;
  isQueueRunning = true;
  isQueuePaused = false;

  const pending = allVideos.filter((v) => !v.thumbnail || !v.duration_probed);
  if (pending.length === 0) {
    thumbProgressContainer.classList.add("hidden");
    isQueueRunning = false;
    return;
  }

  thumbProgressTitle.textContent = "Extraindo miniaturas e durações...";
  thumbProgressContainer.classList.remove("hidden");
  btnPauseThumbs.classList.remove("hidden");
  btnResumeThumbs.classList.add("hidden");

  let completed = 0;
  const total = pending.length;
  thumbProgressFill.style.width = "0%";
  thumbProgressCount.textContent = `0 / ${total}`;

  let currentIndex = 0;
  const newDurations: Record<string, number> = {};

  async function worker() {
    while (currentIndex < pending.length) {
      if (thisSessionId !== thumbQueueSessionId) return;
      if (isQueuePaused) return;

      const video = pending[currentIndex++];
      if (!video) break;

      try {
        const res = await invoke<ThumbGenResult>("generate_single_thumbnail", {
          projectId: currentProjectId,
          videoPath: video.path,
        });

        if (thisSessionId !== thumbQueueSessionId) return;

        video.thumbnail = res.thumbnail;
        video.duration_secs = res.duration_secs;
        video.duration_probed = true;
        newDurations[video.path] = res.duration_secs;

        updateCardInDom(video);
      } catch {
        // Falha silenciosa para arquivos inválidos
      }

      completed++;
      const percent = Math.round((completed / total) * 100);
      thumbProgressFill.style.width = `${percent}%`;
      thumbProgressCount.textContent = `${completed} / ${total}`;

      // Salva progresso em lote a cada 25 vídeos para não perder trabalho em caso de fechamento do app
      if (completed % 25 === 0 && Object.keys(newDurations).length > 0 && currentProjectId) {
        invoke("save_project_durations", {
          projectId: currentProjectId,
          durations: { ...newDurations },
        }).catch(() => {});
      }

      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const workers: Promise<void>[] = [];
  const parallelCount = Math.max(1, Math.min(8, concurrencySetting || 3));
  for (let i = 0; i < parallelCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  if (Object.keys(newDurations).length > 0 && currentProjectId) {
    try {
      await invoke("save_project_durations", {
        projectId: currentProjectId,
        durations: newDurations,
      });
    } catch (e) {
      console.error("Erro ao salvar lote de durações:", e);
    }
  }

  if (thisSessionId === thumbQueueSessionId && !isQueuePaused) {
    thumbProgressTitle.textContent = "Extração concluída!";
    setTimeout(() => {
      if (thisSessionId === thumbQueueSessionId && !isQueuePaused) {
        thumbProgressContainer.classList.add("hidden");
      }
    }, 1500);
  }

  isQueueRunning = false;
}

// ============================================================
// MODAL DE TAGS INDIVIDUAL
// ============================================================
function openTagsModal(video: VideoItem) {
  activeModalVideo = video;
  modalVideoName.textContent = video.name;
  modalSelectedTags = new Set(video.tags);
  renderModalTags();
  tagsModal.classList.remove("hidden");
}

function closeTagsModal() {
  tagsModal.classList.add("hidden");
  activeModalVideo = null;
  newTagInput.value = "";
}

function renderModalTags() {
  modalTagsList.innerHTML = "";
  for (const tag of availableProjectTags) {
    const chip = document.createElement("div");
    const colorClass = getTagColorClass(tag);
    chip.className = `selectable-tag-pill ${colorClass} ${modalSelectedTags.has(tag) ? "selected" : ""}`;
    chip.textContent = tag;
    chip.onclick = () => {
      if (modalSelectedTags.has(tag)) {
        modalSelectedTags.delete(tag);
      } else {
        modalSelectedTags.add(tag);
      }
      renderModalTags();
    };
    modalTagsList.appendChild(chip);
  }
}

async function saveVideoTags() {
  if (!activeModalVideo || !currentProjectId) return;

  const newTagsArray = Array.from(modalSelectedTags);
  try {
    await invoke("set_video_tags", {
      projectId: currentProjectId,
      videoPath: activeModalVideo.path,
      tags: newTagsArray,
    });

    activeModalVideo.tags = newTagsArray;

    for (const t of newTagsArray) {
      if (!availableProjectTags.includes(t)) {
        availableProjectTags.push(t);
      }
    }

    closeTagsModal();
    renderTagFilters();
    renderGrid();
    updateRandomModalMatchingCount();
  } catch (err) {
    console.error("Erro ao salvar tags:", err);
  }
}

function handleAddNewTag() {
  const tagVal = newTagInput.value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!tagVal) return;

  if (!availableProjectTags.includes(tagVal)) {
    availableProjectTags.push(tagVal);
  }
  modalSelectedTags.add(tagVal);
  newTagInput.value = "";
  renderModalTags();
}

// ============================================================
// SEGURANÇA (SENHA DO PROJETO) & RENOMEAR VÍDEOS
// ============================================================
function updatePasswordLabels() {
  const labelText = currentProjectIsLocked ? "Alterar Senha do Projeto..." : "Proteger com Senha...";
  if (btnDropdownPasswordLabel) btnDropdownPasswordLabel.textContent = labelText;
  if (subviewPasswordBtnLabel) subviewPasswordBtnLabel.textContent = currentProjectIsLocked ? "Alterar Senha" : "Proteger com Senha";
}

function openUnlockPasswordModal(projectId: string) {
  pendingUnlockProjectId = projectId;
  if (!projectPasswordModal || !projectPasswordInput) return;
  projectPasswordError?.classList.add("hidden");
  projectPasswordInput.value = "";
  projectPasswordModal.classList.remove("hidden");
  projectPasswordInput.focus();
}

async function handleUnlockProjectSubmit() {
  if (!pendingUnlockProjectId || !projectPasswordInput) return;
  const pass = projectPasswordInput.value;
  try {
    const ok = await invoke<boolean>("verify_project_password", {
      projectId: pendingUnlockProjectId,
      password: pass,
    });
    if (!ok) {
      projectPasswordError?.classList.remove("hidden");
      projectPasswordInput.focus();
      return;
    }
    unlockedProjects.add(pendingUnlockProjectId);
    projectPasswordModal?.classList.add("hidden");
    const targetId = pendingUnlockProjectId;
    pendingUnlockProjectId = null;
    await switchProject(targetId, pass);
  } catch (err) {
    projectPasswordError?.classList.remove("hidden");
  }
}

function openManagePasswordModal() {
  closeAllMenubarDropdowns();
  projectDropdownMenu.classList.add("hidden");
  if (!currentProjectId) {
    showAlertDialog("Selecione um projeto antes de configurar a senha.", "Aviso");
    return;
  }
  if (!projectManagePasswordModal || !managePasswordNewInput) return;
  managePasswordError?.classList.add("hidden");
  managePasswordNewInput.value = "";
  if (managePasswordCurrentInput) managePasswordCurrentInput.value = "";

  if (currentProjectIsLocked) {
    managePasswordCurrentGroup?.classList.remove("hidden");
    if (managePasswordTitle) managePasswordTitle.textContent = "Alterar ou Remover Senha";
  } else {
    managePasswordCurrentGroup?.classList.add("hidden");
    if (managePasswordTitle) managePasswordTitle.textContent = "Definir Senha do Projeto";
  }

  projectManagePasswordModal.classList.remove("hidden");
  if (currentProjectIsLocked && managePasswordCurrentInput) {
    managePasswordCurrentInput.focus();
  } else {
    managePasswordNewInput.focus();
  }
}

async function handleSaveProjectPassword() {
  if (!currentProjectId || !managePasswordNewInput) return;
  const curPass = managePasswordCurrentInput?.value || "";
  const newPass = managePasswordNewInput.value.trim();

  try {
    await invoke("set_project_password", {
      projectId: currentProjectId,
      currentPassword: currentProjectIsLocked ? curPass : null,
      newPassword: newPass.length > 0 ? newPass : null,
    });

    currentProjectIsLocked = newPass.length > 0;
    if (currentProjectIsLocked) {
      unlockedProjects.add(currentProjectId);
    }
    projectManagePasswordModal?.classList.add("hidden");
    updatePasswordLabels();
    await refreshProjectsList();
    await showAlertDialog(
      newPass.length > 0 ? "Senha do projeto definida com sucesso!" : "Senha do projeto removida com sucesso!",
      "Segurança do Projeto"
    );
  } catch (err) {
    if (managePasswordError) {
      managePasswordError.textContent = String(err);
      managePasswordError.classList.remove("hidden");
    }
  }
}

function startInlineCardRename(video: VideoItem) {
  if (activeInlineRenameVideoId === video.id) return;

  const card =
    videoGrid.querySelector<HTMLElement>(`.notion-card[data-id="${video.id}"]`) ||
    videoGrid.querySelector<HTMLElement>(`.notion-card[data-path="${CSS.escape(video.path)}"]`);
  const row =
    videoGrid.querySelector<HTMLElement>(`.notion-table-row[data-id="${video.id}"]`) ||
    videoGrid.querySelector<HTMLElement>(`.notion-table-row[data-path="${CSS.escape(video.path)}"]`);

  const container = card || row;
  if (!container) return;

  const titleEl = container.querySelector<HTMLElement>(".card-title-text, .table-title-text");
  if (!titleEl) return;

  container.scrollIntoView({ block: "nearest", behavior: "smooth" });

  activeInlineRenameVideoId = video.id;

  const originalFullName = video.name;
  const lastDot = originalFullName.lastIndexOf(".");
  const baseName = lastDot > 0 ? originalFullName.substring(0, lastDot) : originalFullName;
  const ext = lastDot > 0 ? originalFullName.substring(lastDot) : "";

  titleEl.classList.add("is-editing");
  titleEl.innerHTML = "";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "card-inline-rename-input";
  input.value = baseName;
  input.spellcheck = false;

  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  input.onmousedown = (e) => e.stopPropagation();
  input.oncontextmenu = (e) => e.stopPropagation();

  titleEl.appendChild(input);

  setTimeout(() => {
    input.focus();
    input.select();
  }, 15);

  let finished = false;
  let canBlurCommit = false;

  setTimeout(() => {
    canBlurCommit = true;
  }, 250);

  const finish = (displayName: string) => {
    titleEl.classList.remove("is-editing");
    titleEl.textContent = displayName;
    titleEl.title = displayName;
    activeInlineRenameVideoId = null;
  };

  const cancel = () => {
    if (finished) return;
    finished = true;
    finish(originalFullName);
  };

  const commit = async () => {
    if (finished) return;
    finished = true;

    const newBase = input.value.trim();
    if (!newBase || newBase === baseName) {
      finish(originalFullName);
      return;
    }

    const newFullName = ext ? `${newBase}${ext}` : newBase;

    try {
      const updated = await invoke<VideoItem>("rename_video_file", {
        projectId: currentProjectId,
        oldPath: video.path,
        newName: newFullName,
      });

      // Atualiza na lista allVideos
      const idx = allVideos.findIndex((v) => v.id === video.id || v.path === video.path);
      if (idx !== -1) {
        allVideos[idx] = updated;
      }

      // Atualiza referências locais
      video.name = updated.name;
      video.path = updated.path;
      if (updated.thumbnail) video.thumbnail = updated.thumbnail;
      if (updated.scrub_sprite) video.scrub_sprite = updated.scrub_sprite;

      container.dataset.path = updated.path;

      const extBadge = container.querySelector<HTMLElement>(".card-format-badge, .table-format-badge");
      if (extBadge) {
        const newExt = updated.name.split(".").pop()?.toUpperCase() || "VID";
        extBadge.textContent = newExt;
      }

      finish(updated.name);
    } catch (err: any) {
      finish(originalFullName);
      await showAlertDialog(`Erro ao renomear arquivo: ${err}`, "Erro ao Renomear");
    }
  };

  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  input.onblur = () => {
    if (!canBlurCommit) {
      input.focus();
      return;
    }
    commit();
  };
}

async function handleRenameVideoSubmit() {
  if (!contextTargetVideo || !currentProjectId || !renameVideoInput) return;
  const newName = renameVideoInput.value.trim();
  if (!newName) {
    await showAlertDialog("O nome do vídeo não pode ser vazio.", "Renomear Vídeo");
    return;
  }

  try {
    const updated = await invoke<VideoItem>("rename_video_file", {
      projectId: currentProjectId,
      oldPath: contextTargetVideo.path,
      newName,
    });

    const idx = allVideos.findIndex((v) => v.path === contextTargetVideo!.path || v.id === contextTargetVideo!.id);
    if (idx !== -1) {
      allVideos[idx] = updated;
    }

    renameVideoModal?.classList.add("hidden");
    renderGrid();
  } catch (err) {
    await showAlertDialog(`Erro ao renomear arquivo: ${err}`, "Erro ao Renomear");
  }
}

// ============================================================
// CONFIGURAÇÕES & MENUBAR
// ============================================================
function openSettingsModal() {
  openWorkspaceSubview("settings");
}

function openStatsModal() {
  openWorkspaceSubview("stats");
}

function openManageFoldersModal() {
  openWorkspaceSubview("sources");
}

function closeAllMenubarDropdowns() {
  menubarDropdowns.forEach((dd) => dd.classList.add("hidden"));
  menubarBtns.forEach((btn) => btn.classList.remove("active"));
}

// ============================================================
// REGISTRO DE EVENTOS GLOBAIS
// ============================================================
window.addEventListener("DOMContentLoaded", () => {
  setGridSize(currentGridSize);

  // Navegação do Sub-aplicativo
  subviewBtnBack?.addEventListener("click", closeWorkspaceSubview);

  // Fontes do Sub-aplicativo
  subviewBtnAddFolder?.addEventListener("click", handleAddFolderToProject);
  subviewBtnSync?.addEventListener("click", handleSyncProject);
  subviewBtnDeleteProject?.addEventListener("click", handleDeleteCurrentProject);
  subviewToggleSubfolders?.addEventListener("change", handleToggleSubfolders);
  subviewBtnAddLooseFiles?.addEventListener("click", handleAddFilesToProject);
  subviewBtnBatchRemoveFolders?.addEventListener("click", handleBatchRemoveFolders);
  subviewFoldersSelectAll?.addEventListener("change", () => {
    if (!subviewFoldersSelectAll) return;
    if (subviewFoldersSelectAll.checked) {
      currentProjectFolders.forEach((f) => selectedFolderPaths.add(f));
    } else {
      selectedFolderPaths.clear();
    }
    updateFolderSelectionUI();
  });

  // Configurações do Sub-aplicativo
  subviewSettingHoverScrub?.addEventListener("change", () => {
    hoverScrubbingEnabled = subviewSettingHoverScrub.checked;
    localStorage.setItem("lms_hover_scrub", hoverScrubbingEnabled ? "true" : "false");
    renderGrid();
  });

  subviewSettingPlayer?.addEventListener("change", () => {
    preferredPlayer = subviewSettingPlayer.value;
    localStorage.setItem("lms_preferred_player", preferredPlayer);
  });

  subviewSettingConcurrency?.addEventListener("change", () => {
    concurrencySetting = parseInt(subviewSettingConcurrency.value, 10);
    localStorage.setItem("lms_concurrency", concurrencySetting.toString());
  });

  subviewBtnClearCache?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog({
      title: "Limpar Cache de Miniaturas",
      message: "Deseja realmente limpar todo o cache de miniaturas geradas?\n\nElas serão regeradas sob demanda automaticamente quando necessário.",
      confirmText: "Limpar Cache",
      cancelText: "Cancelar",
      danger: true,
      type: "warning",
    });
    if (confirmed) {
      try {
        const deletedCount = await invoke<number>("clear_thumbnail_cache");
        await showAlertDialog(`Cache de miniaturas limpo com sucesso!\n${deletedCount} arquivo(s) temporário(s) removido(s).`, "Cache Limpo");
      } catch (err) {
        await showAlertDialog(`Erro ao limpar cache: ${err}`, "Erro ao Limpar Cache");
      }
    }
  });

  // Menubar Clássico Superior
  menubarBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menuId = btn.getAttribute("data-menu");
      if (!menuId) return;
      const targetMenu = document.getElementById(menuId);
      if (!targetMenu) return;

      const isAlreadyOpen = !targetMenu.classList.contains("hidden");
      closeAllMenubarDropdowns();
      projectDropdownMenu.classList.add("hidden");
      sortDropdownMenu?.classList.add("hidden");

      if (!isAlreadyOpen) {
        targetMenu.classList.remove("hidden");
        btn.classList.add("active");
      }
    });
  });

  menuActNewProject?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    openQuickpickProject();
  });

  menuActRenameProject?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    openQuickpickRenameProject();
  });

  menuActPasswordProject?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    openManagePasswordModal();
  });

  menuActManageFolders?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    openManageFoldersModal();
  });

  menuActAddFiles?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    handleAddFilesToProject();
  });

  menuActSync?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    handleSyncProject();
  });

  menuActDeleteProject?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    handleDeleteCurrentProject();
  });

  menuActSelectAll?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    selectAllVideos();
  });

  menuActClearSelect?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    clearBatchSelection();
  });

  menuActRandom?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    openRandomModal();
  });

  menuActStats?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    openStatsModal();
  });

  menuZoomActions.forEach((item) => {
    item.addEventListener("click", () => {
      closeAllMenubarDropdowns();
      const size = item.getAttribute("data-set-zoom") as "small" | "medium" | "large";
      if (size) setGridSize(size);
    });
  });

  menubarBtnSettings?.addEventListener("click", openSettingsModal);
  btnOpenSettings?.addEventListener("click", openSettingsModal);

  menubarBtnAbout?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    showAlertDialog(
      "LMS Video Explorer • v1.0.0\n\nOrganizador de vídeos profissional de alta performance.\nConstruído com Tauri v2, Rust e FFmpeg.\nInterface inspirada no Obsidian Dark Luxe com aceleração nativa e zero travamentos.",
      "Sobre o LMS Video Explorer"
    );
  });

  // Atalhos Globais de Teclado
  window.addEventListener("keydown", (e) => {
    const activeEl = document.activeElement;
    const isInputFocused =
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement ||
      activeEl instanceof HTMLSelectElement;

    if (e.key === "Escape") {
      closeAllMenubarDropdowns();
      closeContextMenu();
      if (appDialogModal && !appDialogModal.classList.contains("hidden")) {
        closeAppDialog(false);
        return;
      }
      if (activeSubviewPane !== null) {
        closeWorkspaceSubview();
        return;
      }
      if (quickpickBar && !quickpickBar.classList.contains("hidden")) closeQuickpickProject();
      if (renameVideoModal && !renameVideoModal.classList.contains("hidden")) renameVideoModal.classList.add("hidden");
      if (projectPasswordModal && !projectPasswordModal.classList.contains("hidden")) {
        projectPasswordModal.classList.add("hidden");
        pendingUnlockProjectId = null;
      }
      if (projectManagePasswordModal && !projectManagePasswordModal.classList.contains("hidden")) projectManagePasswordModal.classList.add("hidden");
      if (!batchTagsModal.classList.contains("hidden")) batchTagsModal.classList.add("hidden");
      if (!tagsModal.classList.contains("hidden")) closeTagsModal();
      if (!randomModal.classList.contains("hidden")) closeRandomModal();
      if (duplicatesModal && !duplicatesModal.classList.contains("hidden")) {
        duplicatesModal.classList.add("hidden");
        return;
      }
      if (moveCopyModal && !moveCopyModal.classList.contains("hidden")) {
        moveCopyModal.classList.add("hidden");
        return;
      }
      if (selectedVideoIds.size > 0) clearBatchSelection();
      return;
    }

    if (isInputFocused) return;

    if (e.key === "/") {
      e.preventDefault();
      searchInput.focus();
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        openQuickpickProject();
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        selectAllVideos();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        openRandomModal();
      } else if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        openDuplicatesModal();
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        appSidebar?.classList.toggle("sidebar-collapsed");
        localStorage.setItem("lms_sidebar_collapsed", appSidebar?.classList.contains("sidebar-collapsed") ? "true" : "false");
      }
    } else if (e.key === "Delete") {
      e.preventDefault();
      const targetPaths: string[] = [];
      if (selectedVideoIds.size > 0) {
        for (const id of selectedVideoIds) {
          const v = allVideos.find((item) => item.id === id);
          if (v) targetPaths.push(v.path);
        }
      } else if (contextTargetVideo) {
        targetPaths.push(contextTargetVideo.path);
      }
      if (targetPaths.length > 0) {
        handleMoveVideosToTrash(targetPaths);
      }
    } else if (e.key === "F2") {
      e.preventDefault();
      let targetVideo: VideoItem | undefined = undefined;
      const targetId = lastSelectedVideoId || (selectedVideoIds.size === 1 ? Array.from(selectedVideoIds)[0] : null);
      if (targetId) {
        targetVideo = allVideos.find((v) => v.id === targetId);
      } else if (contextTargetVideo) {
        targetVideo = contextTargetVideo;
      }
      if (targetVideo) {
        startInlineCardRename(targetVideo);
      } else {
        openQuickpickRenameProject();
      }
    } else if (e.key === "F5") {
      e.preventDefault();
      handleSyncProject();
    }
  });

  // Dropdown de Projetos
  btnProjectDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenubarDropdowns();
    projectDropdownMenu.classList.toggle("hidden");
    sortDropdownMenu?.classList.add("hidden");
  });

  // Renomear Projeto
  btnRenameCurrentProject?.addEventListener("click", () => {
    openQuickpickRenameProject();
  });

  btnDropdownRenameProject?.addEventListener("click", () => {
    projectDropdownMenu.classList.add("hidden");
    openQuickpickRenameProject();
  });

  // Senha do Projeto
  btnDropdownPasswordProject?.addEventListener("click", () => {
    projectDropdownMenu.classList.add("hidden");
    openManagePasswordModal();
  });

  subviewBtnProjectPassword?.addEventListener("click", openManagePasswordModal);

  // Criar Tags na Sidebar
  btnSidebarAddTag?.addEventListener("click", () => {
    if (!currentProjectId) {
      showAlertDialog("Selecione um projeto antes de criar tags.", "Aviso");
      return;
    }
    sidebarNewTagWrap?.classList.remove("hidden");
    sidebarNewTagInput?.focus();
    sidebarNewTagInput?.select();
  });

  sidebarNewTagClose?.addEventListener("click", () => {
    sidebarNewTagWrap?.classList.add("hidden");
    if (sidebarNewTagInput) sidebarNewTagInput.value = "";
  });

  async function handleSidebarCreateTag() {
    if (!sidebarNewTagInput || !currentProjectId) return;
    const tagVal = sidebarNewTagInput.value.trim().toLowerCase().replace(/\s+/g, "-");
    if (!tagVal) return;

    try {
      const updatedTags = await invoke<string[]>("add_project_tag", {
        projectId: currentProjectId,
        tag: tagVal,
      });
      availableProjectTags = updatedTags;
      sidebarNewTagInput.value = "";
      sidebarNewTagWrap?.classList.add("hidden");
      renderTagFilters();
    } catch (err) {
      showAlertDialog(`Erro ao criar tag: ${err}`, "Erro");
    }
  }

  sidebarNewTagInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSidebarCreateTag();
    } else if (e.key === "Escape") {
      sidebarNewTagWrap?.classList.add("hidden");
      if (sidebarNewTagInput) sidebarNewTagInput.value = "";
    }
  });

  // Alternador de Visualização (Grade / Tabela)
  btnViewGrid?.addEventListener("click", () => setViewMode("grid"));
  btnViewTable?.addEventListener("click", () => setViewMode("table"));

  // Agrupamento Dinâmico Dropdown (se presente)
  btnGroupDropdown?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenubarDropdowns();
    sortDropdownMenu?.classList.add("hidden");
    projectDropdownMenu.classList.add("hidden");
    groupDropdownMenu?.classList.toggle("hidden");
  });

  document.querySelectorAll(".group-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const group = el.getAttribute("data-group") as GroupByMode;
      const label = el.textContent?.trim() || "Nenhum";
      setGroupBy(group, `Agrupar: ${label}`);
      groupDropdownMenu?.classList.add("hidden");
    });
  });

  // Ordenação Dropdown (se presente)
  btnSortDropdown?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenubarDropdowns();
    groupDropdownMenu?.classList.add("hidden");
    sortDropdownMenu?.classList.toggle("hidden");
    projectDropdownMenu.classList.add("hidden");
  });

  document.querySelectorAll(".sort-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const mode = el.getAttribute("data-sort") as SortMode;
      const label = el.textContent?.trim() || "Nome (A-Z)";
      setSortMode(mode, label);
      sortDropdownMenu?.classList.add("hidden");
    });
  });

  // Zoom do Grid
  zoomBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const size = target.getAttribute("data-size") as "small" | "medium" | "large";
      setGridSize(size);
    });
  });

  initViewContextMenu();

  window.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    projectDropdownMenu.classList.add("hidden");
    sortDropdownMenu?.classList.add("hidden");
    groupDropdownMenu?.classList.add("hidden");
    closeContextMenu();
    closeViewContextMenu();
  });

  // Projetos & QuickPick Estilo VS Code
  btnOpenCreateProjectModal.addEventListener("click", () => {
    projectDropdownMenu.classList.add("hidden");
    openQuickpickProject();
  });

  btnCreateFirstProject.addEventListener("click", () => {
    openQuickpickProject();
  });

  quickpickSubmitBtn?.addEventListener("click", handleQuickpickSubmit);
  quickpickCloseBtn?.addEventListener("click", closeQuickpickProject);
  quickpickInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleQuickpickSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeQuickpickProject();
    }
  });

  // Fechar Modais e QuickPick ao Clicar no Fundo (Backdrop Click)
  document.querySelectorAll<HTMLElement>(".modal-overlay, .quickpick-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.classList.add("hidden");
        if (overlay.id === "app-dialog-modal") closeAppDialog(false);
        if (overlay.id === "tags-modal") closeTagsModal();
        if (overlay.id === "random-modal") closeRandomModal();
        if (overlay.id === "quickpick-bar") closeQuickpickProject();
        if (overlay.id === "rename-video-modal") overlay.classList.add("hidden");
        if (overlay.id === "project-password-modal") {
          overlay.classList.add("hidden");
          pendingUnlockProjectId = null;
        }
        if (overlay.id === "project-manage-password-modal") overlay.classList.add("hidden");
      }
    });
  });

  btnDialogConfirm?.addEventListener("click", () => closeAppDialog(true));
  btnDialogCancel?.addEventListener("click", () => closeAppDialog(false));

  // Modal de Renomear Vídeo
  renameVideoConfirmBtn?.addEventListener("click", handleRenameVideoSubmit);
  renameVideoCancelBtn?.addEventListener("click", () => {
    renameVideoModal?.classList.add("hidden");
  });
  renameVideoInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRenameVideoSubmit();
    } else if (e.key === "Escape") {
      renameVideoModal?.classList.add("hidden");
    }
  });

  // Modal de Desbloqueio por Senha
  projectPasswordConfirmBtn?.addEventListener("click", handleUnlockProjectSubmit);
  projectPasswordCancelBtn?.addEventListener("click", () => {
    projectPasswordModal?.classList.add("hidden");
    pendingUnlockProjectId = null;
  });
  projectPasswordInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleUnlockProjectSubmit();
    } else if (e.key === "Escape") {
      projectPasswordModal?.classList.add("hidden");
      pendingUnlockProjectId = null;
    }
  });

  // Modal de Gerenciamento de Senha do Projeto
  managePasswordSaveBtn?.addEventListener("click", handleSaveProjectPassword);
  managePasswordCancelBtn?.addEventListener("click", () => {
    projectManagePasswordModal?.classList.add("hidden");
  });
  managePasswordNewInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveProjectPassword();
    } else if (e.key === "Escape") {
      projectManagePasswordModal?.classList.add("hidden");
    }
  });
  managePasswordCurrentInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      managePasswordNewInput?.focus();
    }
  });

  btnManageFolders.addEventListener("click", () => openWorkspaceSubview("sources"));
  btnAddFolderEmpty.addEventListener("click", handleAddFolderToProject);
  btnAddFileEmpty?.addEventListener("click", handleAddFilesToProject);

  // Sincronizar & Métricas
  btnSyncProject?.addEventListener("click", handleSyncProject);
  btnViewStats.addEventListener("click", () => openWorkspaceSubview("stats"));

  // Ações em Lote
  btnBatchClear.addEventListener("click", clearBatchSelection);
  btnBatchFavorite.addEventListener("click", handleBatchFavorite);
  btnBatchAddTags.addEventListener("click", () => openBatchTagsModal("add"));
  btnBatchRemoveTags.addEventListener("click", () => openBatchTagsModal("remove"));
  btnBatchMove?.addEventListener("click", () => {
    const paths = getSelectedVideoPaths();
    if (paths.length > 0) openMoveCopyModal(paths, true);
  });
  btnBatchCopy?.addEventListener("click", () => {
    const paths = getSelectedVideoPaths();
    if (paths.length > 0) openMoveCopyModal(paths, false);
  });
  btnBatchTrash?.addEventListener("click", () => {
    const paths = getSelectedVideoPaths();
    if (paths.length > 0) handleMoveVideosToTrash(paths);
  });
  btnCloseBatchTagsModal.addEventListener("click", () => {
    batchTagsModal.classList.add("hidden");
  });
  btnSubmitBatchTags.addEventListener("click", submitBatchTags);

  btnPauseThumbs.addEventListener("click", () => {
    isQueuePaused = true;
    thumbProgressTitle.textContent = "Extração pausada";
    btnPauseThumbs.classList.add("hidden");
    btnResumeThumbs.classList.remove("hidden");
  });

  btnResumeThumbs.addEventListener("click", () => {
    isQueuePaused = false;
    btnResumeThumbs.classList.add("hidden");
    btnPauseThumbs.classList.remove("hidden");
    startBackgroundThumbnailGeneration();
  });

  btnCancelThumbs.addEventListener("click", () => {
    thumbQueueSessionId++;
    isQueueRunning = false;
    isQueuePaused = false;
    thumbProgressContainer.classList.add("hidden");
  });

  // Busca em tempo real
  searchInput.addEventListener("input", (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    btnClearSearch.classList.toggle("hidden", searchQuery === "");
    renderGrid();
  });

  btnClearSearch.addEventListener("click", () => {
    searchQuery = "";
    searchInput.value = "";
    btnClearSearch.classList.add("hidden");
    renderGrid();
  });

  // Navegação da Barra Lateral (Biblioteca)
  navAllVideos?.addEventListener("click", () => {
    filterSelectedSource = null;
    filterOnlyFavorites = false;
    filterOnlyUntagged = false;
    selectedFilterTags.clear();
    navAllVideos.classList.add("active");
    filterFavBtn?.classList.remove("active");
    navUntaggedVideos?.classList.remove("active");
    renderSidebarFolders();
    renderTagFilters();
    renderGrid();
  });

  filterFavBtn?.addEventListener("click", () => {
    filterOnlyFavorites = !filterOnlyFavorites;
    filterOnlyUntagged = false;
    filterSelectedSource = null;
    selectedFilterTags.clear();
    navAllVideos?.classList.toggle("active", !filterOnlyFavorites);
    filterFavBtn.classList.toggle("active", filterOnlyFavorites);
    navUntaggedVideos?.classList.remove("active");
    renderSidebarFolders();
    renderTagFilters();
    renderGrid();
  });

  navUntaggedVideos?.addEventListener("click", () => {
    filterOnlyUntagged = !filterOnlyUntagged;
    filterOnlyFavorites = false;
    filterSelectedSource = null;
    selectedFilterTags.clear();
    navAllVideos?.classList.toggle("active", !filterOnlyUntagged);
    navUntaggedVideos.classList.toggle("active", filterOnlyUntagged);
    filterFavBtn?.classList.remove("active");
    renderSidebarFolders();
    renderTagFilters();
    renderGrid();
  });

  btnToggleSidebar?.addEventListener("click", () => {
    if (!appSidebar) return;
    appSidebar.classList.toggle("sidebar-collapsed");
    localStorage.setItem("lms_sidebar_collapsed", appSidebar.classList.contains("sidebar-collapsed") ? "true" : "false");
  });

  if (localStorage.getItem("lms_sidebar_collapsed") === "true") {
    appSidebar?.classList.add("sidebar-collapsed");
  }

  // Menu de Contexto
  ctxPlay.addEventListener("click", () => {
    if (contextTargetVideo) playVideo(contextTargetVideo.path);
    closeContextMenu();
  });

  ctxFav.addEventListener("click", () => {
    if (contextTargetVideo) toggleFavorite(contextTargetVideo);
    closeContextMenu();
  });

  ctxTagsOpenModal?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (contextTargetVideo) openTagsModal(contextTargetVideo);
    closeContextMenu();
  });

  ctxQuickTagInput?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  ctxQuickTagInput?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (contextTargetVideo && ctxQuickTagInput.value) {
        await createAndApplyTagDirectly(contextTargetVideo, ctxQuickTagInput.value);
      }
    }
  });

  ctxExplorer.addEventListener("click", () => {
    if (contextTargetVideo) invoke("open_in_explorer", { videoPath: contextTargetVideo.path });
    closeContextMenu();
  });

  ctxCopyPath.addEventListener("click", () => {
    if (contextTargetVideo) navigator.clipboard.writeText(contextTargetVideo.path);
    closeContextMenu();
  });

  ctxMoveFile?.addEventListener("click", () => {
    if (contextTargetVideo) openMoveCopyModal([contextTargetVideo.path], true);
    closeContextMenu();
  });

  ctxCopyFile?.addEventListener("click", () => {
    if (contextTargetVideo) openMoveCopyModal([contextTargetVideo.path], false);
    closeContextMenu();
  });

  ctxTrashFile?.addEventListener("click", () => {
    if (contextTargetVideo) handleMoveVideosToTrash([contextTargetVideo.path]);
    closeContextMenu();
  });

  menuActDuplicates?.addEventListener("click", () => {
    closeAllMenubarDropdowns();
    openDuplicatesModal();
  });

  // Modal de Duplicados
  duplicatesModalClose?.addEventListener("click", () => {
    duplicatesModal?.classList.add("hidden");
  });
  duplicatesModalBtnDone?.addEventListener("click", () => {
    duplicatesModal?.classList.add("hidden");
  });
  btnScanDuplicates?.addEventListener("click", scanProjectDuplicates);
  duplicatesCriteriaSelect?.addEventListener("change", scanProjectDuplicates);

  // Modal de Mover/Copiar
  moveCopyBtnCancel?.addEventListener("click", () => {
    moveCopyModal?.classList.add("hidden");
  });
  moveCopyBtnBrowse?.addEventListener("click", handleBrowseMoveCopyFolder);
  moveCopyBtnConfirm?.addEventListener("click", executeMoveOrCopy);

  ctxRenameVideo?.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = contextTargetVideo;
    closeContextMenu();
    if (target) {
      setTimeout(() => {
        startInlineCardRename(target);
      }, 30);
    }
  });

  mainScrollViewport.addEventListener("scroll", () => {
    closeContextMenu();
  });

  mainScrollViewport.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (
      !target.closest(".notion-card") &&
      !target.closest("#context-menu") &&
      !target.closest(".batch-action-bar") &&
      !target.closest(".app-menubar") &&
      !target.closest(".app-sidebar") &&
      !target.closest(".modal-overlay") &&
      !target.closest("#workspace-subview-container")
    ) {
      if (selectedVideoIds.size > 0) {
        clearBatchSelection();
      }
    }
  });

  // Modal de Tags Individual
  btnCloseTagsModal.addEventListener("click", closeTagsModal);
  btnSaveTags.addEventListener("click", saveVideoTags);
  btnAddNewTag.addEventListener("click", handleAddNewTag);
  newTagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddNewTag();
    }
  });

  // Modal de Sorteio
  btnOpenRandomModal.addEventListener("click", openRandomModal);
  btnCloseRandomModal.addEventListener("click", closeRandomModal);
  btnExecuteRandomPlay.addEventListener("click", executeRandomPlay);

  randomTitleInput?.addEventListener("input", () => {
    randomTitleFilter = randomTitleInput.value;
    updateRandomModalMatchingCount();
  });

  randomTitleInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeRandomPlay();
    }
  });

  randomFavControl.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest(".segment-btn") as HTMLButtonElement;
    if (!target) return;
    const val = target.dataset.val as FavFilterMode;
    if (!val) return;

    randomFavMode = val;
    randomFavControl.querySelectorAll(".segment-btn").forEach((btn) => btn.classList.remove("active"));
    target.classList.add("active");
    updateRandomModalMatchingCount();
  });

  ctxRemoveFile?.addEventListener("click", async () => {
    if (!contextTargetVideo || !currentProjectId) {
      closeContextMenu();
      return;
    }
    const videoPath = contextTargetVideo.path;
    const videoName = contextTargetVideo.name;
    const folderOrigin = contextTargetVideo.folder_origin;
    const isLoose = currentProjectFiles.includes(videoPath);
    closeContextMenu();

    if (isLoose) {
      const confirmed = await showConfirmDialog({
        title: "Remover Vídeo do Projeto",
        message: `Deseja remover "${videoName}" deste projeto?\n\nO arquivo original no disco não será excluído.`,
        confirmText: "Remover",
        cancelText: "Cancelar",
        danger: true,
        type: "danger",
      });
      if (confirmed) {
        await handleRemoveFileFromProject(videoPath);
      }
    } else {
      await showAlertDialog(
        `Este vídeo faz parte da pasta vinculada:\n${folderOrigin}\n\nPara removê-lo do projeto, desvincule a pasta no gerenciador de fontes ou exclua o arquivo no disco.`,
        "Vídeo em Pasta Vinculada"
      );
    }
  });

  // Drag & Drop Nativo (Tauri v2) de Arquivos e Pastas
  try {
    const currentWin = getCurrentWebviewWindow();
    let dragOverWatchdog: number | null = null;

    currentWin.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter") {
        dragDropOverlay?.classList.remove("hidden");
      } else if (p.type === "over") {
        dragDropOverlay?.classList.remove("hidden");
        // Watchdog de segurança: se o usuário cancelar o arraste fora da tela sem evento leave
        if (dragOverWatchdog) clearTimeout(dragOverWatchdog);
        dragOverWatchdog = window.setTimeout(() => {
          dragDropOverlay?.classList.add("hidden");
        }, 1200);
      } else if (p.type === "leave") {
        if (dragOverWatchdog) clearTimeout(dragOverWatchdog);
        dragDropOverlay?.classList.add("hidden");
      } else if (p.type === "drop") {
        if (dragOverWatchdog) clearTimeout(dragOverWatchdog);
        dragDropOverlay?.classList.add("hidden");
        if (p.paths && p.paths.length > 0) {
          handleDroppedPaths(p.paths);
        }
      }
    });
  } catch (err) {
    console.warn("Native drag & drop listener not available:", err);
  }

  // Medidas de segurança adicionais para o overlay nunca ficar travado na tela
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget || e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
      dragDropOverlay?.classList.add("hidden");
    }
  });

  window.addEventListener("dragend", () => {
    dragDropOverlay?.classList.add("hidden");
  });

  window.addEventListener("blur", () => {
    dragDropOverlay?.classList.add("hidden");
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      dragDropOverlay?.classList.add("hidden");
    }
  });

  // Prevenir comportamento padrão do navegador
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  // Prevenir menu padrão do Chromium e abrir menu customizado de visualização
  window.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault();

    const target = e.target as HTMLElement;

    // Se estiver digitando ou interagindo com input/select, não abre menu de visualização
    if (target.closest("input, textarea, select")) {
      return;
    }

    // Se houver algum modal aberto, não abre menu da visualização
    const openModal = document.querySelector(".modal-overlay:not(.hidden)");
    if (openModal) {
      return;
    }

    // Se clicou em tag chip no menu lateral (já tem seu handler próprio)
    if (target.closest(".sidebar-tag-chip") || target.closest(".tag-chip")) {
      return;
    }

    // Se clicou em um card ou linha de vídeo (o handler do card já abre o context-menu de vídeo)
    if (target.closest(".video-card") || target.closest(".video-table-row") || target.closest(".notion-card")) {
      return;
    }

    // Em qualquer outro lugar do aplicativo, abre o menu de contexto de visualização
    openViewContextMenu(e);
  });

  // Sincronização Inteligente Automática ao Retornar à Janela do App (Window Focus)
  let lastFocusSyncTime = 0;
  window.addEventListener("focus", async () => {
    if (!currentProjectId) return;
    const now = Date.now();
    if (now - lastFocusSyncTime < 2500) return;
    lastFocusSyncTime = now;

    try {
      const report = await invoke<SyncReport>("sync_project", { projectId: currentProjectId });
      if (report.added_count > 0 || report.removed_count > 0) {
        const res = await invoke<ProjectViewResult>("load_project_videos", {
          projectId: currentProjectId,
          password: null,
        });
        allVideos = res.videos;
        renderGrid();
        renderSidebarFolders();
        renderTagFilters();
        const totalSize = allVideos.reduce((acc, v) => acc + v.size_bytes, 0);
        statsBadge.textContent = `${allVideos.length} vídeos • ${formatFileSize(totalSize)}`;
      }
    } catch {
      // Silencioso em caso de erro no background
    }
  });

  refreshProjectsList();
});
