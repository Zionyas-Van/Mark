// ==========================================
// 1. 启动检查与全局变量
// ==========================================
function checkDependencies() {
    const missing = [];
    if (typeof Neutralino === 'undefined') missing.push('Neutralino');
    if (typeof marked === 'undefined') missing.push('marked.min.js');
    if (typeof CodeMirror === 'undefined') missing.push('codemirror-bundle.js');
    if (missing.length > 0) { alert("核心组件加载失败！"); return false; }
    return true;
}
if (!checkDependencies()) throw new Error("Missing dependencies");

let DATA_DIR_ROOT = ""; 
let CURRENT_DIR = "";   
let currentFilePath = null;
let selectedListItem = null; 
let selectedTrashItem = null; 
let editor; 
let lastSavedContent = ""; 
let autoSaveTimer = null;  

// 剪贴板与移动状态
let clipboard = { action: null, path: null, name: null };
let moveTargetDir = "";
let moveSourcePath = "";
let TRASH_DIR = ""; 

let SETTINGS_FILE = ""; 
let appSettings = {
    autoSaveInterval: 30, // 秒
    theme: "default",     // default, dark, light
    fontSize: 14
};

// ==========================================
// 2. 初始化逻辑
// ==========================================
async function waitForNeutralino() {
    return new Promise((resolve) => {
        if (window.Neutralino) resolve();
        else {
            document.addEventListener('neutralinoReady', resolve);
            const check = setInterval(() => { if (window.Neutralino) { clearInterval(check); resolve(); } }, 100);
        }
    });
}

document.addEventListener('DOMContentLoaded', async function() {
    await waitForNeutralino();
    Neutralino.init();
        Neutralino.events.on("windowClose", async () => {
        // 1. 如果有打开的文件，先保存
        if (currentFilePath && editor) {
            const content = editor.getValue();
            if (content !== lastSavedContent) {
                await saveFileInternal(currentFilePath, content);
            }
        }
        
        // 2. 弹出确认框
        const confirmed = await showCustomDialog("退出 Mark", "确定要关闭软件吗？所有更改已自动保存。", "", true);
        
        if (confirmed !== null) {
            Neutralino.app.exit();
        } else {
        }
    });

    // 初始化 CodeMirror
    editor = CodeMirror(document.getElementById("editor-container"), {
        mode: "markdown", lineNumbers: true, theme: "default",
        lineWrapping: true, readOnly: true, value: ""
    });

    // =========================================
    // 实时预览与链接拦截逻辑
    // =========================================

    // 1. 监听编辑器内容变化，实时更新预览
    editor.on("change", function() {
        if (currentFilePath) {
            renderPreview(editor.getValue());
        }
        updateStatusBar();
    });

    // 2. 拦截预览区的点击事件
    const previewDiv = document.getElementById('preview');
    if (previewDiv) {
        previewDiv.addEventListener('click', function(e) {
            // 找到被点击的链接元素
            let target = e.target;
            while (target && target !== this) {
                if (target.tagName === 'A') {
                    e.preventDefault(); // 阻止默认跳转
                    const href = target.getAttribute('href');
                    
                    // 判断是内部锚点还是外部链接
                    if (href && href.startsWith('#')) {
                        // 内部锚点：在预览区内滚动
                        const id = href.substring(1);
                        const anchor = document.getElementById(id);
                        if (anchor) {
                            anchor.scrollIntoView({ behavior: 'smooth' });
                        }
                    } else if (href) {
                        // 外部链接：弹窗确认
                        showCustomDialog("打开链接", `确定要使用 Windows 默认浏览器打开 ${href} 吗？`, "", true).then(result => {
                            if (result !== null) {
                                Neutralino.os.open(href);
                            }
                        });
                    }
                    break;
                }
                target = target.parentNode;
            }
        });
    }

    // 同步滚动逻辑
    const editorScroll = document.querySelector('.CodeMirror-scroll');
    const previewScroll = document.getElementById('preview');
    let isEditorScrolling = false, isPreviewScrolling = false;
    
    editorScroll.addEventListener('scroll', function() {
        if (!isEditorScrolling) {
            isPreviewScrolling = true;
            const percentage = editorScroll.scrollTop / (editorScroll.scrollHeight - editorScroll.clientHeight);
            previewScroll.scrollTop = percentage * (previewScroll.scrollHeight - previewScroll.clientHeight);
            setTimeout(() => { isPreviewScrolling = false; }, 50);
        }
        isEditorScrolling = true; setTimeout(() => { isEditorScrolling = false; }, 50);
    });
    
    previewScroll.addEventListener('scroll', function() {
        if (!isPreviewScrolling) {
            isEditorScrolling = true;
            const percentage = previewScroll.scrollTop / (previewScroll.scrollHeight - previewScroll.clientHeight);
            editorScroll.scrollTop = percentage * (editorScroll.scrollHeight - editorScroll.clientHeight);
            setTimeout(() => { isEditorScrolling = false; }, 50);
        }
        isPreviewScrolling = true; setTimeout(() => { isPreviewScrolling = false; }, 50);
    });

    // =========================================
    // 3. 文件系统核心逻辑
    // =========================================
    
    async function initSystemDir() {
        try {
            const basePath = await Neutralino.os.getPath('data');
            DATA_DIR_ROOT = `${basePath}/MarkNotes`; 
            TRASH_DIR = `${DATA_DIR_ROOT}/.Trash`; 
            
            await Neutralino.filesystem.createDirectory(DATA_DIR_ROOT).catch(() => {});
            await Neutralino.filesystem.createDirectory(TRASH_DIR).catch(() => {}); 
            
            CURRENT_DIR = DATA_DIR_ROOT;
            refreshFileList();
            updatePathNav();
        } catch (err) { showToast("初始化目录失败: " + err.message, "error"); }
    }

    function updatePathNav(targetName = null) {
        const navContainer = document.getElementById('path-nav');
        if (!navContainer) return;
        
        let html = `<span class="path-segment" onclick="navigateToRoot()">MarkNotes</span>`;
        if (CURRENT_DIR !== DATA_DIR_ROOT) {
            const parts = CURRENT_DIR.replace(DATA_DIR_ROOT + '/', '').split('/');
            parts.forEach(part => { html += `<span class="path-separator">/</span><span class="path-segment">${part}</span>`; });
        }
        if (targetName) {
            html += `<span class="path-separator">/</span><span class="path-segment" style="color:#0366d6; font-weight:bold;">${targetName}</span>`;
        }
        navContainer.innerHTML = html;
    }

    async function refreshFileList() {
        const listContainer = document.getElementById('file-list');
        if (!listContainer) return;
        
        listContainer.innerHTML = ''; // 清空当前列表
        
        try {
            // 1. 读取目录
            let entries = await Neutralino.filesystem.readDirectory(CURRENT_DIR);
            
            // 2. 直接过滤掉黑名单文件
            // 定义需要隐藏的文件和文件夹名称
            const hiddenItems = ['.Trash', 'settings.json', 'skins']; 
            
            entries = entries.filter(entry => {
                const name = entry.entryName || entry.entry;
                // 如果在根目录，额外确保 .Trash 被隐藏
                if (CURRENT_DIR === DATA_DIR_ROOT && name === '.Trash') return false;
                // 全局隐藏 settings.json 和 skins
                if (hiddenItems.includes(name)) return false;
                return true;
            });

            // 3. 格式化并排序
            const validEntries = entries.map(e => ({
                name: e.entryName || e.entry, 
                type: e.type
            })).sort((a, b) => {
                if (a.type === b.type) return (a.name || "").localeCompare(b.name || "");
                return a.type === 'DIRECTORY' ? -1 : 1;
            });

            // 4. 渲染列表
            validEntries.forEach(entry => {
                const li = document.createElement('li');
                li.className = 'file-item';
                
                // 高亮当前选中的文件
                if (currentFilePath === `${CURRENT_DIR}/${entry.name}`) {
                    li.classList.add('active');
                }

                // 根据类型显示不同图标
                let iconSvg = '';
                let isLink = false;
                let displayName = entry.name;
                let itemClass = 'file-item';

                // 检查是否是链接文件
                if (entry.name.startsWith('_link_')) {
                    isLink = true;
                    displayName = entry.name.replace(/^_link_\d+_/,'');
                    iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#005fb8" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
                    itemClass += ' link-item';
                } else if (entry.type === 'DIRECTORY') {
                    iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffb900" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
                    itemClass += ' folder-item';
                } else {
                    iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60cdff" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
                    
                    // 检查是否为图片文件
                    const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'];
                    const ext = entry.name.split('.').pop().toLowerCase();
                    if (imgExts.includes(ext)) {
                        itemClass += ' image-item';
                    }
                }
                
                li.className = itemClass;
                li.innerHTML = `<span class="icon-svg">${iconSvg}</span> ${displayName}`;
                
                // 绑定点击事件
                li.onclick = () => switchFileWithProtection(entry, isLink);
                
                // 绑定右键菜单
                li.oncontextmenu = (e) => showItemContextMenu(e, entry.name, li);
                
                listContainer.appendChild(li);
            });
        } catch (err) { 
            console.error("读取目录失败:", err); 
            showToast("无法加载文件列表", "error");
        }
    }

    // 处理点击事件
    async function handleItemClick(entry, isLink = false) {
        if (entry.type === 'DIRECTORY') {
            CURRENT_DIR = `${CURRENT_DIR}/${entry.name}`;
            closeFile(); 
            refreshFileList(); updatePathNav();
        } else {
            let filePath = `${CURRENT_DIR}/${entry.name}`;
            
            // 链接文件先读取目标路径
            if (isLink || entry.name.startsWith('_link_')) {
                try {
                    const content = await Neutralino.filesystem.readFile(filePath);
                    const linkData = JSON.parse(content);
                    if (linkData.type === 'external_link') {
                        filePath = linkData.target; // 切换到真实路径
                    }
                } catch (e) {
                    showToast("链接文件损坏", "error");
                    return;
                }
            }

            const ext = entry.name.split('.').pop().toLowerCase();
            const realExt = filePath.split('.').pop().toLowerCase();
            
            if (realExt === 'md' || realExt === 'markdown') {
                loadFileFromPath(filePath, entry.name); // 传入显示名称
            } 
            else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(realExt)) {
                Neutralino.os.open(filePath);
            } 
            else {
                showToast(`不支持预览 .${realExt} 类型文件`, "info");
            }
        }
    }

    // 从指定路径加载文件
    async function loadFileFromPath(path, displayName) {
        try {
            const content = await Neutralino.filesystem.readFile(path);
            editor.setOption("readOnly", false); 
            editor.setValue(content);
            
            currentFilePath = path; 
            lastSavedContent = content; // 更新内容快照
            
            document.title = `Mark - ${displayName}`;
            updateToolbarFilename(displayName);
            
            document.getElementById('editor-overlay').style.display = 'none'; 
            renderPreview(content);
            
            refreshFileList(); 
            updatePathNav(displayName); 
            
            startAutoSaveTimer(); // 启动自动保存计时器
        } catch (err) { showToast("打开文件失败: " + err.message, "error"); }
    }

    // =========================================
    // 顶部逻辑
    // =========================================

    let isPreviewVisible = true;

    // 1. 切换预览显示
    window.togglePreview = function() {
        const previewDiv = document.getElementById('preview');
        const editorContainer = document.getElementById('editor-container');
        const icon = document.getElementById('preview-icon');
        
        if (isPreviewVisible) {
            previewDiv.style.display = 'none';
            editorContainer.style.width = '100%';
            icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
        } else {
            previewDiv.style.display = 'block';
            editorContainer.style.width = '50%';
            icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
        }
        isPreviewVisible = !isPreviewVisible;
    };

    // 2. 更新顶部文件名显示
    function updateToolbarFilename(name) {
        const display = document.getElementById('current-filename-display');
        if (display) {
            display.innerText = name || "未选择文件";
            display.title = name ? `点击重命名: ${name}` : "未选择文件";
        }
    }

    // 3. 从工具栏触发重命名
    window.triggerRenameFromToolbar = async function() {
        if (!currentFilePath) {
            showToast("选中一个 Markdown 以开始编辑", "info");
            return;
        }
        // 模拟选中侧边栏该项并触发重命名
        const fileName = currentFilePath.split('/').pop();
        selectedListItem = { name: fileName, element: null };
        renameItem();
    };

    // 4. 搜索功能
    window.openSearchModal = async function() {
        const keyword = await showCustomDialog("搜索文章", "请输入关键词:", "");
        if (!keyword) return;

        const results = [];
        try {
            // 递归搜索 MarkNotes 目录
            await searchDirectory(DATA_DIR_ROOT, keyword.toLowerCase(), results);
            
            if (results.length === 0) {
                showToast("未找到匹配的文章", "info");
                return;
            }

            // 构建搜索结果 HTML
            let html = '<ul id="search-results-list">';
            results.forEach(item => {
                const icon = item.type === 'DIRECTORY' 
                    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'
                    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
                
                // 高亮关键词
                const highlightedName = item.name.replace(new RegExp(keyword, 'gi'), match => `<span class="search-highlight">${match}</span>`);
                
                html += `<li class="search-result-item" onclick="navigateToSearchResult('${item.path}', '${item.type}')">
                            ${icon} ${highlightedName}
                         </li>`;
            });
            html += '</ul>';

            const modal = document.getElementById('custom-modal');
            document.getElementById('modal-title').innerText = `找到 ${results.length} 个结果`;
            document.getElementById('modal-message').innerHTML = html;
            document.getElementById('modal-input').style.display = 'none';
            document.getElementById('modal-cancel-btn').style.display = 'none';
            document.getElementById('modal-confirm-btn').innerText = '关闭';
            document.getElementById('modal-confirm-btn').onclick = () => closeModal(null);
            modal.style.display = 'flex';

        } catch (err) {
            console.error(err);
            showToast("搜索过程中出错", "error");
        }
    };

    // 递归搜索辅助函数
    async function searchDirectory(dirPath, keyword, results) {
        try {
            const entries = await Neutralino.filesystem.readDirectory(dirPath);
            for (const entry of entries) {
                const name = entry.entryName || entry.entry;
                if (name === '.Trash') continue;
                
                const fullPath = `${dirPath}/${name}`;
                if (name.toLowerCase().includes(keyword)) {
                    results.push({ name: name, path: fullPath, type: entry.type });
                }
                
                if (entry.type === 'DIRECTORY') {
                    await searchDirectory(fullPath, keyword, results);
                }
            }
        } catch (e) { /* 忽略权限错误 */ }
    }

    // 跳转到搜索结果
    window.navigateToSearchResult = async function(path, type) {
        closeModal(null);
        if (type === 'DIRECTORY') {
            CURRENT_DIR = path;
            refreshFileList();
            updatePathNav();
        } else {
            // 如果是文件，先切换到其所在目录，再加载
            const dir = path.substring(0, path.lastIndexOf('/'));
            const fileName = path.split('/').pop();
            CURRENT_DIR = dir;
            refreshFileList();
            updatePathNav();
            await loadFileFromPath(path, fileName);
        }
    };

    window.closeImageModal = function() {
        const modal = document.getElementById('image-modal');
        const imgElement = document.getElementById('modal-image');
        if (modal) modal.style.display = 'none';
        if (imgElement) imgElement.src = ''; // 清空 src 防止内存泄漏
    };

    async function loadFile(filename) {
        if (!filename) return;
        try {
            const path = `${CURRENT_DIR}/${filename}`;
            const content = await Neutralino.filesystem.readFile(path);
            
            // 关键：恢复编辑器可编辑状态
            editor.setOption("readOnly", false); 
            editor.setValue(content);
            
            currentFilePath = path;
            document.title = `Mark - ${filename}`;
            
            // 隐藏遮罩层
            document.getElementById('editor-overlay').style.display = 'none'; 
            
            // 【关键修复】强制刷新预览区，确保 Markdown 被重新渲染
            renderPreview(content);
            
            refreshFileList(); 
            updatePathNav(filename); 
        } catch (err) { showToast("打开文件失败", "error"); }
    }

    // 独立的预览渲染函数
    function renderPreview(content) {
        const previewDiv = document.getElementById('preview');
        if (previewDiv) {
            previewDiv.innerHTML = marked.parse(content || "");
        }
    }

    function closeFile() {
        currentFilePath = null;
        lastSavedContent = ""; 
        stopAutoSaveTimer(); 
        
        editor.setOption("readOnly", true);
        editor.setValue("");
        
        // 清空预览区和遮罩层
        document.getElementById('preview').innerHTML = ""; 
        document.getElementById('editor-overlay').style.display = 'flex'; 
        
        document.title = "Mark";
        updateToolbarFilename(null);
        updatePathNav();
    }

    // =========================================
    // 4. 菜单与交互
    // =========================================
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.oncontextmenu = (e) => {
            if (e.target.closest('#sidebar')) { e.preventDefault(); showMenu('sidebar-context-menu', e.pageX, e.pageY); }
        };
    }
    function showItemContextMenu(e, filename, element) {
        e.preventDefault(); e.stopPropagation();
        selectedListItem = { name: filename, element: element };
        showMenu('item-context-menu', e.pageX, e.pageY);
    }
    const fileBtn = document.getElementById('file-menu-btn');
    if (fileBtn) {
        fileBtn.onclick = (e) => { e.stopPropagation(); showMenu('file-dropdown', e.target.offsetLeft, e.target.offsetTop + 40); };
    }
    function showMenu(menuId, x, y) {
        document.querySelectorAll('.dropdown-menu, .context-menu').forEach(m => m.style.display = 'none');
        const menu = document.getElementById(menuId);
        if (menu) { 
            menu.style.display = 'block'; 
            
            // 获取菜单的实际高度
            const menuHeight = menu.offsetHeight;
            const windowHeight = window.innerHeight;
            
            // 如果下方空间不足，则向上显示
            if (y + menuHeight > windowHeight) {
                menu.style.top = (y - menuHeight) + 'px';
            } else {
                menu.style.top = y + 'px';
            }
            
            menu.style.left = x + 'px'; 
        }
    }
    document.addEventListener('click', () => { document.querySelectorAll('.dropdown-menu, .context-menu').forEach(m => m.style.display = 'none'); });

    // =========================================
    // 5. 辅助工具：Toast 与 弹窗
    // =========================================
    function showToast(message, type = "info") {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerText = message;
        if (type === "error") toast.style.backgroundColor = "#d93025";
        container.appendChild(toast);
        setTimeout(() => { toast.remove(); }, 3000);
    }

    const modal = document.getElementById('custom-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    const modalInput = document.getElementById('modal-input');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    const cancelBtn = document.getElementById('modal-cancel-btn');
    let modalResolve = null;

    function showCustomDialog(title, message, defaultValue = "", isConfirmOnly = false) {
        return new Promise((resolve) => {
            modalResolve = resolve;
            modalTitle.innerText = title;
            modalMessage.innerText = message;
            modalInput.value = defaultValue;
            
            // 重置 UI 状态
            modalInput.style.display = 'block';
            cancelBtn.style.display = 'block';
            confirmBtn.innerText = '确定';
            
            if (isConfirmOnly) {
                modalInput.style.display = 'none';
                cancelBtn.style.display = 'none';
                confirmBtn.innerText = '确定';
            }
            
            // 重新绑定确认按钮事件
            confirmBtn.onclick = () => {
                const val = modalInput.value;
                resetModalState(); // 关闭前先重置
                closeModal(val);
            };
            
            modal.style.zIndex = 2000; 
            modal.style.display = 'flex';
            setTimeout(() => modalInput.focus(), 100);
        });
    }

    function resetModalState() {
        modal.style.display = 'none';
        modal.style.zIndex = 1500;
        modalInput.style.display = 'block';
        cancelBtn.style.display = 'block';
        confirmBtn.innerText = '确定';
        confirmBtn.onclick = () => {
             const val = modalInput.value;
             resetModalState();
             closeModal(val);
        };
        if (modalResolve) { 
        }
    }

    function closeModal(result) {
        modal.style.display = 'none';
        modal.style.zIndex = 1500; 
        if (modalResolve) { modalResolve(result); modalResolve = null; }
    }

    // 绑定取消按钮
    cancelBtn.onclick = () => {
        resetModalState();
        closeModal(null);
    };

    // 绑定背景点击
    modal.onclick = (e) => { 
        if (e.target === modal) {
            resetModalState();
            closeModal(null);
        } 
    };
    
    // 绑定回车键
    modalInput.onkeydown = (e) => { if (e.key === 'Enter') confirmBtn.click(); };


    // =========================================
    // 核心功能函数
    // =========================================
    
    window.navigateToRoot = function() { CURRENT_DIR = DATA_DIR_ROOT; closeFile(); refreshFileList(); updatePathNav(); };
    
    window.openTrashModal = async function() {
        document.getElementById('trash-modal').style.display = 'flex';
        await renderTrashList();
    };

    window.closeTrashModal = function() {
        document.getElementById('trash-modal').style.display = 'none';
        selectedTrashItem = null;
    };

    async function renderTrashList() {
        const list = document.getElementById('trash-file-list');
        list.innerHTML = '';
        try {
            const entries = await Neutralino.filesystem.readDirectory(TRASH_DIR);
            if (entries.length === 0) {
                list.innerHTML = '<li style="justify-content:center; color:#999;">回收站是空的</li>';
                return;
            }
            entries.forEach(entry => {
                const name = entry.entryName || entry.entry;
                const li = document.createElement('li');
                li.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d93025" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg> ${name}`;
                li.onclick = () => {
                    document.querySelectorAll('#trash-file-list li').forEach(el => el.classList.remove('trash-selected'));
                    li.classList.add('trash-selected');
                    selectedTrashItem = name;
                };
                li.oncontextmenu = (e) => {
                    e.preventDefault();
                    selectedTrashItem = name;
                    li.classList.add('trash-selected');
                    showMenu('trash-item-context-menu', e.pageX, e.pageY);
                };
                list.appendChild(li);
            });
        } catch (err) { console.error(err); }
    }

    async function checkNameExists(name) {
        try {
            const entries = await Neutralino.filesystem.readDirectory(CURRENT_DIR);
            return entries.some(e => (e.entryName || e.entry) === name);
        } catch (e) { return false; }
    }

    window.createNewFile = async function() {
        const name = await showCustomDialog("新建文件", "输入一个后缀为 .md 的新文件:", "note.md");
        if (name) {
            const finalName = name.endsWith('.md') ? name : name + '.md';
            if (await checkNameExists(finalName)) {
                showToast("文件名已存在！", "error");
                return;
            }
            try {
                await Neutralino.filesystem.writeFile(`${CURRENT_DIR}/${finalName}`, "# 新笔记\n");
                refreshFileList();
                showToast("文件创建成功");
            } catch (err) { showToast("创建失败", "error"); }
        }
    };

    // =========================================
    // 注册表关联逻辑
    // =========================================
    window.setAsDefaultApp = async function() {
        const confirmed = await showCustomDialog("系统设置", "要将 Mark 作为默认的 Markdown 打开方式吗？", "", true);
        
        if (confirmed !== null) {
            try {
                // 获取当前 exe 的路径
                let appPath = await Neutralino.app.getPath();
                
                // 关键：将路径中的正斜杠替换为反斜杠，并处理空格
                appPath = appPath.replace(/\//g, '\\');
                
                // 构造注册表命令
                // 1. 关联 .md 后缀到类名 MarkNotesFile
                // 2. 定义 MarkNotesFile 的打开命令
                const cmd1 = `reg add "HKCU\\Software\\Classes\\.md" /ve /d "MarkNotesFile" /f`;
                const cmd2 = `reg add "HKCU\\Software\\Classes\\MarkNotesFile\\shell\\open\\command" /ve /d "\\"${appPath}\\" \\"%1\\"" /f`;

                // 使用 cmd /c 执行以确保环境正确
                await Neutralino.os.execCommand(`cmd /c ${cmd1}`);
                await Neutralino.os.execCommand(`cmd /c ${cmd2}`);

                showToast("已将 Mark 设置为默认的 Markdown 打开方式");
            } catch (err) {
                console.error(err);
                showToast("设置失败，请尝试右键软件图标选择‘以管理员身份运行’", "error");
            }
        }
    };

    window.createNewFolder = async function() {
        const name = await showCustomDialog("新建文件夹", "为新文件夹命名:", "New Folder");
        if (name) {
            if (await checkNameExists(name)) {
                showToast("文件夹名已存在！", "error");
                return;
            }
            try { await Neutralino.filesystem.createDirectory(`${CURRENT_DIR}/${name}`); refreshFileList(); showToast("文件夹创建成功"); } 
            catch (err) { showToast("创建失败", "error"); }
        }
    };

    window.saveAsFile = async function() {
        if (!currentFilePath) { showToast("请先打开一个文件", "error"); return; }
        try {
            const result = await Neutralino.os.showSaveDialog("另存为 Markdown 文件", {
                filters: [{ name: "Markdown Files", extensions: ["md"] }]
            });
            if (result) {
                await Neutralino.filesystem.writeFile(result, editor.getValue());
                showToast("系统级另存为成功");
            }
        } catch (err) { 
            const name = await showCustomDialog("另存为 (内部)", "请输入文件名:", "new-note.md");
            if (name) {
                const finalName = name.endsWith('.md') ? name : name + '.md';
                if (await checkNameExists(finalName)) { showToast("文件名已存在！", "error"); return; }
                currentFilePath = `${CURRENT_DIR}/${finalName}`;
                await Neutralino.filesystem.writeFile(currentFilePath, editor.getValue());
                refreshFileList(); updatePathNav(finalName); 
                showToast("另存为成功");
            }
        }
    };

    window.saveCurrentFile = async function() {
        if (!currentFilePath) { showToast("空气已被保存", "error"); return; }
        try { 
            await Neutralino.filesystem.writeFile(currentFilePath, editor.getValue()); 
            showToast("文章已被保存");
        } catch (err) { showToast("保存失败", "error"); }
    };

    window.openDataFolder = async function() {
        try { await Neutralino.os.open(DATA_DIR_ROOT); } catch (err) { showToast("无法打开", "error"); }
    };

    window.renameItem = async function() {
        if (!selectedListItem) return;
        const oldName = selectedListItem.name;
        const extIndex = oldName.lastIndexOf('.');
        const nameWithoutExt = extIndex !== -1 ? oldName.substring(0, extIndex) : oldName;
        const ext = extIndex !== -1 ? oldName.substring(extIndex) : "";

        const newName = await showCustomDialog("重命名", "为此重命名:", nameWithoutExt);
        if (newName && newName !== nameWithoutExt) {
            const finalNewName = newName + ext;
            if (await checkNameExists(finalNewName)) {
                showToast("目标名称已存在！", "error");
                return;
            }
            try {
                await Neutralino.filesystem.move(`${CURRENT_DIR}/${oldName}`, `${CURRENT_DIR}/${finalNewName}`);
                if (currentFilePath && currentFilePath.endsWith(oldName)) {
                    currentFilePath = `${CURRENT_DIR}/${finalNewName}`;
                    document.title = `Mark - ${finalNewName}`;
                    updatePathNav(finalNewName);
                }
                refreshFileList();
                showToast("已重命名");
            } catch (err) { showToast("重命名失败", "error"); }
        }
    };

    // 外部文件链接管理
    window.openExternalFile = async function() {
        try {
            // 调用系统文件选择器，只允许选 .md 文件
            const result = await Neutralino.os.showOpenDialog("选择 Markdown 文件", {
                filters: [{ name: "Markdown Files", extensions: ["md"] }]
            });
            
            if (result && result.length > 0) {
                const originalPath = result[0];
                const fileName = originalPath.split(/[/\\]/).pop(); // 获取文件名
                
                // 创建一个唯一的链接文件名，避免冲突
                const linkName = `_link_${Date.now()}_${fileName}`;
                const linkContent = JSON.stringify({
                    type: "external_link",
                    target: originalPath,
                    created: new Date().toISOString()
                });

                // 将链接文件保存到 MarkNotes 根目录
                await Neutralino.filesystem.writeFile(`${DATA_DIR_ROOT}/${linkName}`, linkContent);
                
                refreshFileList();
                showToast("外部文章已添加到列表");
            }
        } catch (err) { 
            console.error(err);
            showToast("选择文件失败", "error"); 
        }
    };

    window.deleteItem = async function() {
        if (!selectedListItem) return;
        const confirmed = await showCustomDialog("确认删除", `确定要将 ${selectedListItem.name} 移入回收站吗？`, "", true);
        if (confirmed !== null) {
            try {
                await Neutralino.filesystem.move(`${CURRENT_DIR}/${selectedListItem.name}`, `${TRASH_DIR}/${selectedListItem.name}`);
                if (currentFilePath && currentFilePath.includes(selectedListItem.name)) closeFile();
                refreshFileList();
                showToast("已移入回收站");
            } catch (err) { showToast("删除失败", "error"); }
        }
    };

    window.copyItem = async function() {
        if (!selectedListItem) return;
        if (currentFilePath) { try { await Neutralino.filesystem.writeFile(currentFilePath, editor.getValue()); } catch(e){} }
        clipboard = { action: 'copy', path: `${CURRENT_DIR}/${selectedListItem.name}`, name: selectedListItem.name };
        showToast(`已复制: ${selectedListItem.name}`);
    };

    window.cutItem = async function() {
        if (!selectedListItem) return;
        if (currentFilePath) { try { await Neutralino.filesystem.writeFile(currentFilePath, editor.getValue()); } catch(e){} }
        clipboard = { action: 'cut', path: `${CURRENT_DIR}/${selectedListItem.name}`, name: selectedListItem.name };
        showToast(`已剪切: ${selectedListItem.name}`);
    };

    window.pasteFromClipboard = async function() {
        if (!clipboard.path) { showToast("剪贴板为空", "error"); return; }
        if (await checkNameExists(clipboard.name)) {
            showToast("目标位置已有同名文件", "error");
            return;
        }
        
        const destPath = `${CURRENT_DIR}/${clipboard.name}`;
        try {
            if (clipboard.action === 'copy') {
                const content = await Neutralino.filesystem.readFile(clipboard.path);
                await Neutralino.filesystem.writeFile(destPath, content);
            } else if (clipboard.action === 'cut') {
                await Neutralino.filesystem.move(clipboard.path, destPath);
                clipboard = { action: null, path: null, name: null };
            }
            refreshFileList();
            showToast("粘贴成功");
        } catch (err) { showToast("粘贴失败", "error"); }
    };

    window.moveItem = async function() {
        if (!selectedListItem) return;
        moveSourcePath = `${CURRENT_DIR}/${selectedListItem.name}`;
        moveTargetDir = DATA_DIR_ROOT; 
        openMoveSelector();
    };

    async function openMoveSelector() {
        document.getElementById('move-modal').style.display = 'flex';
        renderMoveList();
    }

    async function renderMoveList() {
        const moveList = document.getElementById('move-file-list');
        const moveNav = document.getElementById('move-path-nav');
        moveList.innerHTML = '';
        
        let navHtml = `<span onclick="changeMoveDir('${DATA_DIR_ROOT}')">MarkNotes</span>`;
        if (moveTargetDir !== DATA_DIR_ROOT) {
            const parts = moveTargetDir.replace(DATA_DIR_ROOT + '/', '').split('/');
            let tempPath = DATA_DIR_ROOT;
            parts.forEach(p => {
                tempPath += '/' + p;
                navHtml += ` / <span onclick="changeMoveDir('${tempPath}')">${p}</span>`;
            });
        }
        moveNav.innerHTML = navHtml;

        try {
            const entries = await Neutralino.filesystem.readDirectory(moveTargetDir);
            entries.forEach(entry => {
                const entryName = entry.entryName || entry.entry;
                if (entry.type === 'DIRECTORY' && entryName !== '.Trash' && entryName !== 'MarkNotes') {
                    const li = document.createElement('li');
                    li.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg> ${entryName}`;
                    li.onclick = () => {
                        moveTargetDir = `${moveTargetDir}/${entryName}`;
                        renderMoveList();
                    };
                    moveList.appendChild(li);
                }
            });
        } catch (err) { console.error(err); }
    }

    window.changeMoveDir = function(path) {
        moveTargetDir = path;
        renderMoveList();
    };

    window.closeMoveModal = function() {
        document.getElementById('move-modal').style.display = 'none';
    };

    window.confirmMove = async function() {
        if (!moveSourcePath) return;
        const fileName = moveSourcePath.split('/').pop();
        const destPath = `${moveTargetDir}/${fileName}`;
        
        if (await checkNameExistsInPath(moveTargetDir, fileName)) {
            showToast("目标文件夹已有同名文件", "error");
            return;
        }

        try {
            await Neutralino.filesystem.move(moveSourcePath, destPath);
            closeMoveModal();
            refreshFileList();
            if (currentFilePath === moveSourcePath) closeFile();
            showToast("移动成功");
        } catch (err) { showToast("移动失败", "error"); }
    };

    async function checkNameExistsInPath(dirPath, name) {
        try {
            const entries = await Neutralino.filesystem.readDirectory(dirPath);
            return entries.some(e => (e.entryName || e.entry) === name);
        } catch (e) { return false; }
    }

    // =========================================
    // 7. 回收站专用功能
    // =========================================
    
    window.restoreFromTrash = async function() {
        if (!selectedTrashItem) { showToast("请先选择一个文件", "error"); return; }
        const destPath = `${DATA_DIR_ROOT}/${selectedTrashItem}`;
        if (await checkNameExistsInPath(DATA_DIR_ROOT, selectedTrashItem)) {
             showToast("根目录下已有同名文件，无法直接恢复", "error");
             return;
        }
        try {
            await Neutralino.filesystem.move(`${TRASH_DIR}/${selectedTrashItem}`, destPath);
            showToast("文件已恢复");
            renderTrashList();
        } catch (err) { showToast("恢复失败", "error"); }
    };

    // 【修改】改为打开系统资源管理器
    window.permanentlyDeleteFromTrash = async function() {
        if (!selectedTrashItem) { showToast("请先选择一个文件", "error"); return; }
        const confirmed = await showCustomDialog("打开文件夹", `将在系统资源管理器中打开回收站文件夹，请手动删除 ${selectedTrashItem}。`, "", true);
        if (confirmed !== null) {
            try {
                await Neutralino.os.open(TRASH_DIR);
            } catch (err) { showToast("无法打开文件夹", "error"); }
        }
    };

    // 【修改】改为打开系统资源管理器
    window.emptyTrash = async function() {
        const confirmed = await showCustomDialog("打开文件夹", `将在系统资源管理器中打开回收站文件夹，请手动清空所有文件。`, "", true);
        if (confirmed !== null) {
            try {
                await Neutralino.os.open(TRASH_DIR);
            } catch (err) { showToast("无法打开文件夹", "error"); }
        }
    };

    window.refreshFileList = refreshFileList;

    // =========================================
    // 状态栏与编辑器右键菜单逻辑
    // =========================================
    
    // 1. 监听编辑器变化以更新状态栏
    editor.on("change", updateStatusBar);
    editor.on("cursorActivity", updateStatusBar);

    function updateStatusBar() {
        const cursor = editor.getCursor();
        const line = cursor.line + 1;
        const ch = cursor.ch + 1;
        const content = editor.getValue();
        
        // 计算总字符数和字数
        const charCount = content.length;
        const wordCount = content.trim() === "" ? 0 : content.trim().split(/\s+/).length;

        let infoText = `行 ${line}, 列 ${ch} | 字符: ${charCount} | 字数: ${wordCount}`;
        
        // 检查是否有选中文本
        const selection = editor.getSelection();
        const statSelection = document.getElementById('stat-selection');
        
        if (selection.length > 0) {
            statSelection.style.display = 'inline';
            statSelection.innerText = `选中: ${selection.length} 字符`;
        } else {
            statSelection.style.display = 'none';
        }

        document.getElementById('stat-info').innerText = infoText;
    }

    // 2. 编辑器右键菜单处理
    const editorContainer = document.getElementById("editor-container");
    if (editorContainer) {
        editorContainer.oncontextmenu = (e) => {
            if (!currentFilePath || editor.getOption("readOnly")) return;
            e.preventDefault();
            showMenu('editor-context-menu', e.pageX, e.pageY);
        };
    }

    // 3. 执行编辑器命令
    // =========================================
    // 编辑器命令与 Markdown 插入
    // =========================================

    // 1. 执行基础编辑器命令（全选、复制等）
    window.execEditorCmd = function(cmd) {
        if (!editor) return;
        
        switch(cmd) {
            case 'selectAll': editor.execCommand('selectAll'); break;
            case 'copy': 
                // Neutralino 环境下，直接使用浏览器 API 可能受限，但 CodeMirror 内部处理了剪贴板
                // 这里我们尝试触发浏览器的复制行为
                const text = editor.getSelection();
                if (text) {
                    // 简单模拟：将选中文本放入系统剪贴板（如果环境支持）
                    // 在 Neutralino 中，通常依赖用户手动 Ctrl+C，但我们可以提供视觉反馈
                    showToast("已复制到剪贴板 (Ctrl+C)");
                }
                break;
            case 'paste': 
                showToast("请使用 Ctrl+V 粘贴");
                break;
            case 'cut': 
                showToast("请使用 Ctrl+X 剪切");
                break;
        }
        // 隐藏所有菜单
        document.querySelectorAll('.context-menu, .dropdown-menu').forEach(m => m.style.display = 'none');
    };

        // 2. 智能插入 Markdown 语法
    window.insertMarkdown = function(type) {
        if (!currentFilePath || editor.getOption("readOnly")) {
            showToast("请先打开一个 Markdown 文件", "error");
            return;
        }

        const selection = editor.getSelection();
        let textToInsert = "";
        
        // 定义各种语法的模板
        const templates = {
            'bold': `**${selection || '粗体文字'}**`,
            'italic': `*${selection || '斜体文字'}*`,
            'heading': `\n## ${selection || '标题文字'}\n`,
            'list': `\n- ${selection || '列表项'}\n- 列表项`,
            'ordered-list': `\n1. ${selection || '列表项'}\n2. 列表项`,
            'todo': `\n- [ ] ${selection || '待办事项'}\n- [ ] 待办事项`,
            'quote': `\n> ${selection || '引用文字'}\n`,
            'code': `\n\`\`\`\n${selection || '代码内容'}\n\`\`\`\n`,
            'table': `\n| 表头1 | 表头2 |\n| --- | --- |\n| 内容1 | 内容2 |`
        };

        if (templates[type]) {
            textToInsert = templates[type];
            editor.replaceSelection(textToInsert);
            editor.focus();
            
            // 如果没有选中文本，尝试选中新插入的占位符
            if (!selection) {
                const cursor = editor.getCursor();
            }
            
            updateStatusBar();
            renderPreview(editor.getValue());
        }

        // 隐藏所有菜单
        document.querySelectorAll('.context-menu, .dropdown-menu').forEach(m => m.style.display = 'none');
    };

    // 3. 撤销与恢复
    window.editorUndo = function() { if (editor) editor.undo(); };
    window.editorRedo = function() { if (editor) editor.redo(); };

    // 撤销与恢复功能
    window.editorUndo = function() {
        if (editor) editor.undo();
    };

    window.editorRedo = function() {
        if (editor) editor.redo();
    };

    // =========================================
    // 全局右键拦截
    // =========================================

    // 1. 全局禁止默认右键菜单
    document.addEventListener('contextmenu', function(e) {
        // 如果点击的是编辑器内部，交给 CodeMirror 处理（我们在前面已经定义了 editorContainer.oncontextmenu）
        // 如果点击的是侧边栏项目，交给 showItemContextMenu 处理
        // 其他所有情况（包括空白处、预览区、工具栏），一律阻止默认行为
        
        const target = e.target;
        
        // 检查是否点击了我们已经定义了自定义菜单的区域
        const isSidebarItem = target.closest('.file-item');
        const isEditorArea = target.closest('#editor-container') || target.closest('.CodeMirror');
        const isTrashItem = target.closest('#trash-file-list li');
        
        if (!isSidebarItem && !isEditorArea && !isTrashItem) {
            e.preventDefault();
            return false;
        }
    });

    // 2. 禁用常见的浏览器快捷键 (可选，进一步提升原生感)
    document.addEventListener('keydown', function(e) {
        // 例如：禁用 F5 刷新 (Neutralino 有专门的刷新逻辑，不需要浏览器刷新)
        if (e.key === 'F5') {
            e.preventDefault();
            return false;
        }
        // 禁用 Ctrl+R 刷新
        if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
            e.preventDefault();
            return false;
        }
    });

    // =========================================
    // 拖拽打开文件逻辑
    // =========================================

    const dragOverlay = document.getElementById('drag-overlay');
    
    // 1. 阻止浏览器默认行为
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // 2. 监听拖入：显示遮罩层
    document.body.addEventListener('dragenter', (e) => {
        if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
            dragOverlay.style.display = 'flex';
        }
    });

    dragOverlay.addEventListener('dragleave', () => { 
        dragOverlay.style.display = 'none'; 
    });
    
    // 3. 监听释放（Drop）：核心处理逻辑
    document.body.addEventListener('drop', async (e) => {
        dragOverlay.style.display = 'none';    
        
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            const file = files[0];
            const fileName = file.name;
            
            // 【逻辑变更】不再检查后缀名是否必须是 md，而是尝试读取所有文本文件
            // 支持的扩展名列表
            const textExts = ['md', 'markdown', 'txt', 'js', 'css', 'html', 'json', 'xml', 'csv'];
            const ext = fileName.split('.').pop().toLowerCase();
            
            if (textExts.includes(ext)) {
                showToast(`正在导入: ${fileName}...`, "info");
                await importFileAsMarkdown(file);
            } else {
                showToast("仅支持导入文本类文件 (.md, .txt, .js 等)", "error");
            }
        }
    });

    // 4. 核心导入函数：读取内容 -> 创建新 MD 文件 -> 自动打开
    async function importFileAsMarkdown(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            
            reader.onload = async function(e) {
                const content = e.target.result;
                let targetName = file.name;
                
                // 如果原文件不是 .md 或 .markdown，自动加上 .md 后缀
                if (!targetName.endsWith('.md') && !targetName.endsWith('.markdown')) {
                    targetName += '.md';
                }

                // 检查文件名冲突，如果存在则添加时间戳
                if (await checkNameExists(targetName)) {
                    const nameWithoutExt = targetName.substring(0, targetName.lastIndexOf('.'));
                    const extPart = targetName.substring(targetName.lastIndexOf('.'));
                    targetName = `${nameWithoutExt}_${Date.now()}${extPart}`;
                }

                try {
                    // 在根目录创建新文件
                    const newPath = `${DATA_DIR_ROOT}/${targetName}`;
                    await Neutralino.filesystem.writeFile(newPath, content);
                    
                    refreshFileList();
                    
                    // 【体验优化】导入成功后，直接自动打开这个新文件
                    loadFileFromPath(newPath, targetName);
                    
                    showToast(`成功导入并打开: ${targetName}`, "success");
                    resolve();
                } catch (err) {
                    console.error(err);
                    showToast("导入失败", "error");
                    resolve();
                }
            };
            
            reader.onerror = function() {
                showToast("文件读取失败", "error");
                resolve();
            };

            // 以文本形式读取文件
            reader.readAsText(file);
        });
    }

    // =========================================
    // 工具栏水平滚动支持
    // =========================================
    const richToolbar = document.getElementById('rich-toolbar');
    if (richToolbar) {
        richToolbar.addEventListener('wheel', (evt) => {
            evt.preventDefault();
            richToolbar.scrollLeft += evt.deltaY;
        });
    }

    // =========================================
    // 自动保存与切换保护机制
    // =========================================

    // 1. 内部保存逻辑
    async function saveFileInternal(path, content) {
        try {
            await Neutralino.filesystem.writeFile(path, content);
            lastSavedContent = content;
            updateStatusBar();
        } catch (err) {
            console.error("保存失败:", err);
            showToast("保存失败: " + err.message, "error");
        }
    }

    // 2. 启动自动保存计时器
    function startAutoSaveTimer() {
        if (autoSaveTimer) clearInterval(autoSaveTimer);
        autoSaveTimer = setInterval(async () => {
            if (currentFilePath && editor) {
                const content = editor.getValue();
                // 只有内容有变化才保存
                if (content !== lastSavedContent) {
                    await saveFileInternal(currentFilePath, content);
                    showToast("已自动保存", "success");
                }
            }
        }, 30000); // 30秒一次
    }

    // 3. 停止自动保存计时器
    function stopAutoSaveTimer() {
        if (autoSaveTimer) {
            clearInterval(autoSaveTimer);
            autoSaveTimer = null;
        }
    }

    // 4. 手动保存按钮调用的函数
    window.saveCurrentFile = async function() {
        if (!currentFilePath) { showToast("空气已被保存", "error"); return; }
        const content = editor.getValue();
        await saveFileInternal(currentFilePath, content);
        showToast("文章已被保存", "success");
    };

    // 文件切换逻辑
    async function switchFileWithProtection(entry, isLink = false) {
        // 如果当前有打开的文件，先静默保存
        if (currentFilePath && editor) {
            const currentContent = editor.getValue();
            if (currentContent !== lastSavedContent) {
                await saveFileInternal(currentFilePath, currentContent);
                showToast("已自动保存", "info");
            }
        }

        // 执行原有的加载逻辑
        if (entry.type === 'DIRECTORY') {
            CURRENT_DIR = `${CURRENT_DIR}/${entry.name}`;
            closeFile(); 
            refreshFileList(); updatePathNav();
        } else {
            let filePath = `${CURRENT_DIR}/${entry.name}`;
            if (isLink || entry.name.startsWith('_link_')) {
                try {
                    const content = await Neutralino.filesystem.readFile(filePath);
                    const linkData = JSON.parse(content);
                    if (linkData.type === 'external_link') filePath = linkData.target;
                } catch (e) { showToast("链接文件损坏", "error"); return; }
            }

            const realExt = filePath.split('.').pop().toLowerCase();
            if (realExt === 'md' || realExt === 'markdown') {
                loadFileFromPath(filePath, entry.name);
            } else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(realExt)) {
                Neutralino.os.open(filePath);
            } else {
                showToast(`不支持预览 .${realExt} 类型文件`, "info");
            }
        }
    }

    async function initSystemDir() {
        try {
            const basePath = await Neutralino.os.getPath('data');
            DATA_DIR_ROOT = `${basePath}/MarkNotes`; 
            TRASH_DIR = `${DATA_DIR_ROOT}/.Trash`; 
            SETTINGS_FILE = `${DATA_DIR_ROOT}/settings.json`; // 
            
            await Neutralino.filesystem.createDirectory(DATA_DIR_ROOT).catch(() => {});
            await Neutralino.filesystem.createDirectory(TRASH_DIR).catch(() => {}); 
            
            CURRENT_DIR = DATA_DIR_ROOT;
            
            await loadSettings(); 
            applyTheme(appSettings.theme); 
            
            refreshFileList();
            updatePathNav();
        } catch (err) { showToast("初始化目录失败: " + err.message, "error"); }
    }

    // =========================================
    // 配置管理与皮肤系统
    // =========================================

    async function loadSettings() {
        try {
            const content = await Neutralino.filesystem.readFile(SETTINGS_FILE);
            const loaded = JSON.parse(content);
            appSettings = { ...appSettings, ...loaded }; // 合并默认值
        } catch (err) {
            console.log("未找到配置文件");
        }
        // 更新自动保存计时器
        startAutoSaveTimer();
    }

    async function saveSettings() {
        try {
            await Neutralino.filesystem.writeFile(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
            showToast("设置已保存", "success");
        } catch (err) { showToast("保存失败", "error"); }
    }

    // 皮肤切换逻辑

    window.applyTheme = function(themeName) {
        const link = document.getElementById('theme-style');
        if (!link) return;
        
        // 自定义皮肤
        if (themeName.startsWith('custom:')) {
            const fileName = themeName.replace('custom:', '');
            applyCustomSkin(fileName);
            return;
        }

        const themes = {
            'default': 'css/styles.css',
            'dark': 'css/themes/dark.css',
            'light': 'css/themes/light.css'
        };
        
        let targetPath = themes[themeName] || themes['default'];
        console.log("正在加载样式表:", targetPath);
        
        link.href = ''; 
        setTimeout(() => { link.href = targetPath; }, 10);
        
        appSettings.theme = themeName;
    };

    // 更新自动保存间隔
    window.updateAutoSaveInterval = function(seconds) {
        appSettings.autoSaveInterval = parseInt(seconds);
        startAutoSaveTimer(); // 重启计时器以应用新间隔
        saveSettings();
    };

    // =========================================
    // 设置窗口控制
    // =========================================

    window.openSettingsModal = function() {
        const autosaveInput = document.getElementById('setting-autosave');
        const themeSelect = document.getElementById('setting-theme');
        const modal = document.getElementById('settings-modal');

        if (autosaveInput && themeSelect && modal) {
            autosaveInput.value = appSettings.autoSaveInterval;
            themeSelect.value = appSettings.theme;
            modal.style.display = 'flex';
        }
    };

    window.closeSettingsModal = function() {
        const modal = document.getElementById('settings-modal');
        if (modal) modal.style.display = 'none';
    };

    // 从 UI 读取数据并应用到内存
    window.applySettingsFromUI = function() {
        const autosaveVal = parseInt(document.getElementById('setting-autosave').value);
        const themeVal = document.getElementById('setting-theme').value;

        if (!isNaN(autosaveVal) && autosaveVal > 0) {
            appSettings.autoSaveInterval = autosaveVal;
            startAutoSaveTimer();
        }
        
        if (themeVal) {
            appSettings.theme = themeVal;
            applyTheme(themeVal); 
        }

        // 调用保存函数写入磁盘
        saveSettings(); 
    };

    // 保存设置到磁盘
    async function saveSettings() {
        try {
            await Neutralino.filesystem.writeFile(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
            showToast("保存更改", "success");
        } catch (err) { 
            console.error(err);
            showToast("更改未生效", "error"); 
        }
    }
    window.saveSettings = saveSettings;

    // =========================================
    // 配置备份与恢复
    // =========================================

    // 1. 备份设置
    window.backupSettings = async function() {
        try {
            // 弹出保存对话框，让用户选择备份文件存哪
            const result = await Neutralino.os.showSaveDialog("备份 Mark 设置", {
                filters: [{ name: "JSON Files", extensions: ["json"] }]
            });
            
            if (result) {
                // 读取当前内存中的设置
                const content = JSON.stringify(appSettings, null, 2);
                // 写入用户选择的路径
                await Neutralino.filesystem.writeFile(result, content);
                showToast("设置备份成功！", "success");
            }
        } catch (err) {
            console.error(err);
            showToast("备份失败", "error");
        }
    };

    // 2. 恢复设置
    window.restoreSettings = async function() {
        try {
            // 弹出打开对话框，让用户选择备份文件
            const result = await Neutralino.os.showOpenDialog("恢复 Mark 设置", {
                filters: [{ name: "JSON Files", extensions: ["json"] }]
            });
            
            if (result && result.length > 0) {
                const filePath = result[0];
                const content = await Neutralino.filesystem.readFile(filePath);
                const loadedSettings = JSON.parse(content);
                
                // 合并设置
                appSettings = { ...appSettings, ...loadedSettings };
                
                // 应用新设置
                applyTheme(appSettings.theme);
                startAutoSaveTimer();
                
                // 保存到本地 settings.json
                await saveSettings();
                
                showToast("设置已恢复，请重启软件以完全生效", "success");
            }
        } catch (err) {
            console.error(err);
            showToast("恢复失败，请检查文件格式", "error");
        }
    };

    window.applySettingsFromUI = function() {
        const autosaveVal = parseInt(document.getElementById('setting-autosave').value);
        const themeVal = document.getElementById('setting-theme').value;

        if (autosaveVal > 0) {
            appSettings.autoSaveInterval = autosaveVal;
            startAutoSaveTimer(); // 重启计时器
        }
        
        if (themeVal) {
            appSettings.theme = themeVal;
            applyTheme(themeVal); // 立即切换主题
        }

        saveSettings(); // 写入磁盘
    };

    // =========================================
    // 自定义皮肤导入
    // =========================================

    window.importCustomSkin = async function() {
        try {
            const result = await Neutralino.os.showOpenDialog("选择 CSS 皮肤文件", {
                filters: [{ name: "CSS Files", extensions: ["css"] }]
            });
            
            if (result && result.length > 0) {
                const sourcePath = result[0];
                const fileName = sourcePath.split(/[/\\]/).pop(); // 获取文件名
                
                const skinsDir = `${DATA_DIR_ROOT}/skins`;
                await Neutralino.filesystem.createDirectory(skinsDir).catch(() => {});
                
                const targetPath = `${skinsDir}/${fileName}`;
                
                // 读取源文件内容
                const content = await Neutralino.filesystem.readFile(sourcePath);
                
                // 写入到用户数据目录
                await Neutralino.filesystem.writeFile(targetPath, content);
                
                showToast(`皮肤 "${fileName}" 导入成功！`, "success");
                
                // 立即应用新皮肤
                const link = document.getElementById('theme-style');
                if (link) {
                    link.href = '';
                    setTimeout(() => { 
                        applyCustomSkin(fileName); 
                    }, 10);
                }
                
                // 更新设置
                appSettings.theme = `custom:${fileName}`; 
                saveSettings();
            }
        } catch (err) {
            console.error("导入皮肤错误:", err);
            showToast(`导入失败: ${err.message}`, "error");
        }
    };

    // =========================================
    // 自定义皮肤
    // =========================================
    window.applyCustomSkin = async function(fileName) {
        try {
            const skinPath = `${DATA_DIR_ROOT}/skins/${fileName}`;
            
            // 1. 读取 CSS 文件的文本内容
            const content = await Neutralino.filesystem.readFile(skinPath);
            
            // 2. 查找是否已经存在用于自定义皮肤的 style 标签
            let customStyle = document.getElementById('custom-skin-style');
            
            // 3. 如果不存在，就创建一个并添加到 head 中
            if (!customStyle) {
                customStyle = document.createElement('style');
                customStyle.id = 'custom-skin-style';
                document.head.appendChild(customStyle);
            }
            
            // 4. 将读取到的 CSS 内容直接写入 style 标签
            customStyle.innerHTML = content;
            
            console.log("当前自定义皮肤:", fileName);
        } catch (err) {
            console.error("应用自定义皮肤失败:", err);
            showToast("应用皮肤失败", "error");
        }
    };

    // =========================================
    // 关于页面辅助弹窗
    // =========================================

    // 通用的全局弹窗生成器
    function showGlobalInfoModal(title, contentHtml, btnText = '关闭') {
    
        const oldModal = document.getElementById('global-info-modal');
        if (oldModal) oldModal.remove();

        const modal = document.createElement('div');
        modal.id = 'global-info-modal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.4);
            display: flex; justify-content: center; align-items: center;
            z-index: 99999;
        `;

        modal.innerHTML = `
            <div style="
                background: var(--winui-bg-primary, #fff); 
                color: var(--winui-text-primary, #000);
                width: 450px; max-height: 80vh; 
                border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                display: flex; flex-direction: column; overflow: hidden;
            ">
                <div style="padding: 20px; font-size: 18px; font-weight: 600; border-bottom: 1px solid var(--winui-border-light, #eee);">
                    ${title}
                </div>
                <div style="padding: 20px; overflow-y: auto; flex: 1; font-size: 14px; line-height: 1.6;">
                    ${contentHtml}
                </div>
                <div style="padding: 15px 20px; border-top: 1px solid var(--winui-border-light, #eee); text-align: right;">
                    <button id="global-modal-close-btn" style="
                        padding: 6px 20px; border-radius: 4px; border: 1px solid var(--winui-border-light, #ccc);
                        background: var(--winui-accent, #005fb8); color: #fff; cursor: pointer; font-size: 14px;
                    ">${btnText}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const closeBtn = modal.querySelector('#global-modal-close-btn');
        closeBtn.onclick = () => modal.remove();
        
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    // 隐私政策
    window.showPrivacyPolicy = function() {
        const content = `
            <div style="text-align:left; font-size:13px; line-height:1.6;">
                <p><strong>隐私政策摘要：</strong></p>
                <p>1. Mark 是一款本地 Markdown 编辑器，所有数据均存储在您的本地设备上。</p>
                <p>2. 我们不会收集、上传或共享您的任何笔记内容以及个人信息。</p>
                <p>3. 软件仅在您主动点击“检查更新”、“打开外部链接”、“执行云备份”或其必要的账户登录时才会进行联网操作会连接互联网。</p>
                <p>4. 您可以随时通过删除安装目录来彻底清除本软件及其配置，但我们会保留您的笔记内容以便后续恢复。</p>
            </div>
        `;
        showGlobalInfoModal("隐私政策", content, "我知道了");
    };

    // 依赖项说明
    window.showDependencies = function() {
        const content = `
            <div style="text-align:left; font-size:13px; line-height:1.6;">
                <p><strong>核心依赖项：</strong></p>
                <ul style="padding-left: 20px; margin-top: 5px;">
                    <li><strong>Neutralino:</strong> 这是一致跨平台轻量级应用框架</li>
                    <li><strong>Microsoft Edge Webview2:</strong> 这是运行 Mark 的必要依赖项</li>
                    <li><strong>CodeMirror:</strong> 开发者可通过此工具编辑浏览器端代码</li>
                    <li><strong>Marked:</strong> Mark 需要借此解析 Markdown 文章</li>
                </ul>
                <p style="margin-top:10px; color:var(--winui-text-secondary);">感谢所有开源社区贡献者的努力。</p>
            </div>
        `;
        showGlobalInfoModal("依赖项说明", content, "确认");
    };

    initSystemDir();
});