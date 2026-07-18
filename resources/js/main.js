const MarkNet = {
    // 通用 Fetch 封装
    fetch: async function(url, options = {}) {
        try {
            return await fetch(url, options);
        } catch (error) {
            console.error("Network Request Failed:", error);
            throw error;
        }
    },

    // GitHub API 专用请求
    githubRequest: async function(path, method = 'GET', body = null) {
        const token = appSettings.ghToken;
        const owner = appSettings.ghOwner;
        const repo = appSettings.ghRepo;
        const branch = appSettings.ghBranch || 'main';

        if (!token || !owner || !repo) {
            throw new Error("请先在设置中配置 GitHub Token、用户名和仓库名");
        }

        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
        const headers = {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json'
        };

        if (body) {
            headers['Content-Type'] = 'application/json';
        }

        return await this.fetch(url, {
            method: method,
            headers: headers,
            body: body ? JSON.stringify(body) : null
        });
    },


    webdavRequest: async function(path, method = 'PROPFIND', body = null) {
        let baseUrl = appSettings.wdUrl;
        const dir = appSettings.wdDir || '/';
        
        if (!baseUrl) throw new Error("WebDAV 地址未配置");

        if (!baseUrl.endsWith('/')) baseUrl += '/';
        let cleanDir = dir.startsWith('/') ? dir : '/' + dir;

        let fullPath = baseUrl + cleanDir.substring(1); 
        if (path && path !== '/') {
            let cleanPath = path.startsWith('/') ? path.substring(1) : path;
            fullPath += '/' + cleanPath;
        }

        const user = appSettings.wdUser;
        const pass = appSettings.wdPass;
        

        const headers = {
            'Authorization': 'Basic ' + btoa(user + ':' + pass),
            'Depth': '1' 
        };

        if (method === 'PUT') {
            headers['Content-Type'] = 'application/octet-stream'; 
        } else if (method === 'PROPFIND' || method === 'MKCOL') {
            headers['Content-Type'] = 'application/xml; charset=utf-8';
        }

        console.log(`[WebDAV Native] ${method} -> ${fullPath}`);

        try {
            const response = await Neutralino.net.fetch(fullPath, {
                method: method,
                headers: headers,
                body: body
            });
            return response;
        } catch (err) {
            console.error("Neutralino.net.fetch failed:", err);
            throw err;
        }
    }
};


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
    fontSize: 14,
    syncScroll: true,
    ghToken: "",
    ghOwner: "",
    ghRepo: "",
    ghPathTemplate: "imgs/{YYYY}-{MM}-{DD}",
    ghBranch: "master",
    wdUrl: "",
    wdUser: "",
    wdPass: "",
    wdDir: "/MarkNotes/"
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
    // 初始化 CodeMirror
    editor = CodeMirror(document.getElementById("editor-container"), {
        mode: "markdown", 
        lineNumbers: true, 
        theme: "default",
        lineWrapping: true, 
        readOnly: false,
        value: "",
        viewportMargin: 10, 
        extraKeys: {
            "Enter": "newlineAndIndentContinueMarkdownList" 
        }
    });



    // --- 编辑器实时样式装饰器开始 ---
    let markerMap = new Map(); 

    function applyEditorStyles() {
        if (!editor) return;
        markerMap.forEach(marker => marker.clear());
        markerMap.clear();

        const doc = editor.getDoc();
        const viewport = editor.getViewport();
        const startLine = Math.max(0, viewport.from - 5);
        const endLine = Math.min(doc.lineCount(), viewport.to + 5);

        let inFencedCode = false;
        for (let i = 0; i < startLine; i++) {
            const lineText = doc.getLine(i);
            if (lineText !== undefined && /^```/.test(lineText.trim())) {
                inFencedCode = !inFencedCode;
            }
        }

        for (let i = startLine; i < endLine; i++) {
            const text = doc.getLine(i);
            if (text === undefined || text === null) continue;

            // --- 围栏代码块边界检测 ---
            if (/^```/.test(text.trim())) {
                inFencedCode = !inFencedCode;
                markerMap.set(`fence-${i}`, doc.markText(
                    {line: i, ch: 0}, 
                    {line: i, ch: text.length}, 
                    {className: 'cm-fenced-code'}
                ));
                continue;
            }

            // --- 代码块内部 ---
            if (inFencedCode) {
                markerMap.set(`fc-${i}`, doc.markText(
                    {line: i, ch: 0}, 
                    {line: i, ch: text.length}, 
                    {className: 'cm-fenced-code'}
                ));
                continue;
            }

            // --- 标题 ---
            const headerMatch = text.match(/^(#{1,6})\s+(.*)/);
            if (headerMatch) {
                const level = Math.min(headerMatch[1].length, 6);
                const startCh = headerMatch[1].length + 1;
                if (startCh < text.length) {
                    markerMap.set(`h-${i}`, doc.markText(
                        {line: i, ch: startCh}, 
                        {line: i, ch: text.length}, 
                        {className: `cm-header-${level}`}
                    ));
                }
                continue;
            }

            // --- 图片链接 ![alt](url) ---
            let m;
            const imgRe = /!  $ [^ $  ]* $    $ [^)]+ $  /g;
            while ((m = imgRe.exec(text)) !== null) {
                markerMap.set(`img-${i}-${m.index}`, doc.markText(
                    {line: i, ch: m.index}, 
                    {line: i, ch: m.index + m[0].length}, 
                    {className: 'cm-image-link'}
                ));
            }

            // --- 超链接 [text](url) ---
            const linkRe = /(?<!!)  $ [^ $  ]+ $    $ [^)]+ $  /g;
            while ((m = linkRe.exec(text)) !== null) {
                markerMap.set(`link-${i}-${m.index}`, doc.markText(
                    {line: i, ch: m.index}, 
                    {line: i, ch: m.index + m[0].length}, 
                    {className: 'cm-link-text'}
                ));
            }

            // --- 行内代码 `code` ---
            const codeRe = /`[^`]+`/g;
            while ((m = codeRe.exec(text)) !== null) {
                markerMap.set(`code- $ {i}- $ {m.index}`, doc.markText(
                    {line: i, ch: m.index}, 
                    {line: i, ch: m.index + m[0].length}, 
                    {className: 'cm-inline-code'}
                ));
            }

            // --- 粗体 **text** ---
            const boldRe = /\*\*(.+?)\*\*/g;
            while ((m = boldRe.exec(text)) !== null) {
                markerMap.set(`b- $ {i}- $ {m.index}`, doc.markText(
                    {line: i, ch: m.index + 2}, 
                    {line: i, ch: m.index + m[0].length - 2}, 
                    {className: 'cm-strong'}
                ));
            }

            // --- 斜体 *text* ---
            const italicRe = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;
            while ((m = italicRe.exec(text)) !== null) {
                markerMap.set(`i- $ {i}- $ {m.index}`, doc.markText(
                    {line: i, ch: m.index + 1}, 
                    {line: i, ch: m.index + m[0].length - 1}, 
                    {className: 'cm-em'}
                ));
            }
        }
    }

    let styleTimer;
    editor.on("change", () => {
        clearTimeout(styleTimer);
        styleTimer = setTimeout(applyEditorStyles, 200);
    });
    editor.on("viewportChange", () => {
        clearTimeout(styleTimer);
        styleTimer = setTimeout(applyEditorStyles, 100);
    });
    setTimeout(applyEditorStyles, 300);

    // 实时预览与链接拦截逻辑

    let editorScroll = null;
    const previewScroll = document.getElementById('preview');
    let isSyncing = false;
    let lineMap = [];

    // 1. 构建行号映射表
    function buildLineMap(source, previewContainer) {
        lineMap = [];
        if (!source || !previewContainer) return;
        
        const lines = source.split('\n');
        let currentLine = 0;
        
        // 获取预览区所有块级元素
        const blocks = previewContainer.querySelectorAll('h1, h2, h3, h4, h5, h6, p, pre, blockquote, ul, ol, table, hr');
        
        blocks.forEach(block => {
            const topPos = block.offsetTop;
            const textContent = block.textContent.trim().substring(0, 50);
            
            // 简单的启发式匹配：根据文本内容查找源码行号
            if (textContent.length > 5) {
                for (let i = currentLine; i < lines.length; i++) {
                    if (lines[i].includes(textContent.substring(0, 20))) {
                        lineMap.push({
                            previewTop: topPos,
                            sourceLine: i
                        });
                        currentLine = i + 1; 
                        break;
                    }
                }
            }
        });
        
        // 确保最后有一个终点映射
        if (lineMap.length === 0 || lineMap[lineMap.length - 1].sourceLine < lines.length) {
             lineMap.push({
                 previewTop: previewContainer.scrollHeight,
                 sourceLine: lines.length
             });
        }
    }

    // 2. 渲染预览并更新映射
    window.renderPreview = function(content) {
        const previewDiv = document.getElementById('preview');
        if (!previewDiv) return;

        try {
            const html = marked.parse(content || "");
            previewDiv.innerHTML = html;
            // 渲染完成后立即重建映射
            buildLineMap(content, previewDiv);
        } catch (e) {
            console.error("Preview render error:", e);
        }
    };

    // 3. 滚动同步处理函数
    function handleEditorScroll() {
        if (isSyncing || !editorScroll || lineMap.length === 0) return;
        isSyncing = true;

        const lineHeight = editor.defaultTextHeight();
        const currentTopLine = Math.floor(editorScroll.scrollTop / lineHeight);

        let targetPreviewTop = 0;
        for (let i = 0; i < lineMap.length; i++) {
            if (lineMap[i].sourceLine <= currentTopLine) {
                targetPreviewTop = lineMap[i].previewTop;
            } else {
                break;
            }
        }

        previewScroll.scrollTo({
            top: targetPreviewTop,
            behavior: 'auto'
        });

        setTimeout(() => { isSyncing = false; }, 50);
    }

    function handlePreviewScroll() {
        if (isSyncing || !editorScroll || lineMap.length === 0) return;
        isSyncing = true;

        let targetSourceLine = 0;
        for (let i = 0; i < lineMap.length; i++) {
            if (lineMap[i].previewTop <= previewScroll.scrollTop) {
                targetSourceLine = lineMap[i].sourceLine;
            } else {
                break;
            }
        }

        const lineHeight = editor.defaultTextHeight();
        editorScroll.scrollTo({
            top: targetSourceLine * lineHeight,
            behavior: 'auto'
        });

        setTimeout(() => { isSyncing = false; }, 50);
    }

    function initScrollSync() {
        editorScroll = document.querySelector('.CodeMirror-scroll');
        if (!editorScroll || !previewScroll) return;

        editorScroll.removeEventListener('scroll', handleEditorScroll);
        previewScroll.removeEventListener('scroll', handlePreviewScroll);

        if (appSettings.syncScroll) {
            editorScroll.addEventListener('scroll', handleEditorScroll);
            previewScroll.addEventListener('scroll', handlePreviewScroll);
        }
    }

    // 4. 监听编辑器变化
    editor.on("change", function() {
        if (currentFilePath) {
            renderPreview(editor.getValue());
        }
        updateStatusBar();
    });

    // 5. 拦截预览区点击事件
    if (previewScroll) {
        previewScroll.addEventListener('click', function(e) {
            let target = e.target;
            while (target && target !== this) {
                if (target.tagName === 'A') {
                    e.preventDefault();
                    const href = target.getAttribute('href');
                    if (href && href.startsWith('#')) {
                        const id = href.substring(1);
                        const anchor = document.getElementById(id);
                        if (anchor) anchor.scrollIntoView({ behavior: 'smooth' });
                    } else if (href) {
                        showCustomDialog("打开链接", `确定要使用 Windows 默认浏览器打开 ${href} 吗？`, "", true).then(result => {
                            if (result !== null) Neutralino.os.open(href);
                        });
                    }
                    break;
                }
                target = target.parentNode;
            }
        });
    }

    // 延迟初始化滚动同步，确保 DOM 完全就绪
    setTimeout(initScrollSync, 1000);




    // 文件系统核心逻辑
    
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
            updateLocalUsername();
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
            
            // 强制刷新预览区，确保 Markdown 被重新渲染
            renderPreview(content);
            
            refreshFileList(); 
            updatePathNav(filename); 
        } catch (err) { showToast("打开文件失败", "error"); }
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
        if (!currentFilePath) { showToast("你要把空气另存为到你的磁盘里吗", "error"); return; }
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
    window.execEditorCmd = async function(cmd) {
        if (!editor) return;
        
        // 隐藏所有菜单
        document.querySelectorAll('.context-menu, .dropdown-menu').forEach(m => m.style.display = 'none');

        try {
            switch(cmd) {
                case 'selectAll': 
                    editor.execCommand('selectAll'); 
                    break;
                    
                case 'copy': {
                    const text = editor.getSelection();
                    if (text) {
                        // 使用 Neutralino 原生 API 写入剪贴板
                        await Neutralino.clipboard.writeText(text);
                        showToast("已复制到剪贴板", "success");
                    } else {
                        showToast("未选中任何文本", "info");
                    }
                    break;
                }
                
                case 'cut': {
                    const text = editor.getSelection();
                    if (text) {
                        // 1. 先复制
                        await Neutralino.clipboard.writeText(text);
                        // 2. 再删除选中部分
                        editor.replaceSelection("");
                        showToast("已剪切到剪贴板", "success");
                    } else {
                        showToast("未选中任何文本", "info");
                    }
                    break;
                }
                
                case 'paste': {
                    // 使用 Neutralino 原生 API 读取剪贴板
                    const clipboardText = await Neutralino.clipboard.readText();
                    if (clipboardText) {
                        // 将剪贴板内容插入到光标处
                        editor.replaceSelection(clipboardText);
                        showToast("已粘贴", "success");
                    } else {
                        showToast("剪贴板为空", "info");
                    }
                    break;
                }
            }
        } catch (err) {
            console.error("剪贴板操作失败:", err);
            showToast("剪贴板操作失败: " + err.message, "error");
        }
    };

        // 2. 插入 Markdown 语法
    window.insertMarkdown = function(type) {
        if (!currentFilePath || editor.getOption("readOnly")) {
            showToast("你要编辑空气吗", "error");
            return;
        }

        const selection = editor.getSelection();
        let textToInsert = "";
        const selLen = selection.length;

        // 定义各种语法的模板
        const templates = {
            'bold': `**${selection || '粗体文字'}**`,
            'italic': `*${selection || '斜体文字'}*`,
            'heading': `\n## ${selection || '标题文字'}\n`,
            'list': `\n- ${selection || '列表项'}\n- 列表项`,
            'ordered-list': `\n1. ${selection || '列表项'}\n2. 列表项`,
            'todo': `\n- [ ] ${selection || '待办事项'}\n- [ ] 待办事项`,
            'quote': `\n> ${selection || '引用文字'}\n`,
            'table': `\n| 表头1 | 表头2 |\n| --- | --- |\n| 内容1 | 内容2 |`
        };

        if (type === 'code') {
            if (!selection) {
                // 未选中：直接插入大代码块
                textToInsert = "\n```\n代码内容\n```\n";
            } else if (selLen <= 20) {
                // 选中且少于20字：行内代码
                textToInsert = "`" + selection + "`";
            } else {
                // 选中且多于20字：大块代码
                textToInsert = "\n```\n" + selection + "\n```\n";
            }
        } else if (templates[type]) {
            textToInsert = templates[type];
        }

        if (textToInsert) {
            editor.replaceSelection(textToInsert);
            editor.focus();
            
            // 如果没有选中文本，尝试选中新插入的占位符
            if (!selection && type !== 'code') {
                // 这里可以添加更复杂的逻辑来选中“粗体文字”等占位符
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
            updateLocalUsername();
        } catch (err) { showToast("初始化目录失败: " + err.message, "error"); }
    }



    async function loadSettings() {
        try {
            const content = await Neutralino.filesystem.readFile(SETTINGS_FILE);
            const loaded = JSON.parse(content);
            // 合并默认值，防止缺少字段导致报错
            appSettings = { ...appSettings, ...loaded }; 
            console.log("设置加载成功:", appSettings);
        } catch (err) {
            console.log("未找到配置文件或解析失败，使用默认设置");
            // 如果文件不存在，尝试创建一个默认的
            try {
                await saveSettings();
            } catch(e) {}
        }
        // 根据加载的设置更新运行时状态
        startAutoSaveTimer();
        applyTheme(appSettings.theme);
    }

    async function saveSettings() {
        try {
            await Neutralino.filesystem.writeFile(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
            console.log("设置已写入文件");
        } catch (err) { 
            console.error("保存设置失败:", err); 
            showToast("保存设置文件失败", "error"); 
        }
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


    window.updateAutoSaveInterval = function(seconds) {
        appSettings.autoSaveInterval = parseInt(seconds);
        startAutoSaveTimer(); 
        saveSettings();
    };



    window.openSettingsModal = function() {
        const modal = document.getElementById('settings-modal');
        const autosaveInput = document.getElementById('setting-autosave');
        const syncScrollCheck = document.getElementById('setting-sync-scroll');
        const themeSelect = document.getElementById('setting-theme');
        if (themeSelect) themeSelect.value = appSettings.theme || 'default';
        if (autosaveInput) autosaveInput.value = appSettings.autoSaveInterval || 30;
        if (syncScrollCheck) syncScrollCheck.checked = appSettings.syncScroll !== false;
        if (!modal) {
            console.error("未找到设置窗口 DOM 元素");
            return;
        }

        // 1. 填充 GitHub 设置
        const ghTokenInput = document.getElementById('setting-gh-token');
        const ghOwnerInput = document.getElementById('setting-gh-owner');
        const ghRepoInput = document.getElementById('setting-gh-repo');
        const ghBranchInput = document.getElementById('setting-gh-branch');
        const ghPathInput = document.getElementById('setting-gh-path');

        if (ghTokenInput) ghTokenInput.value = appSettings.ghToken || "";
        if (ghOwnerInput) ghOwnerInput.value = appSettings.ghOwner || "";
        if (ghRepoInput) ghRepoInput.value = appSettings.ghRepo || "";
        if (ghBranchInput) ghBranchInput.value = appSettings.ghBranch || "main";
        if (ghPathInput) ghPathInput.value = appSettings.ghPathTemplate || "imgs/{YYYY}-{MM}-{DD}";

        // 2. 填充 WebDAV 设置
        const wdUrlInput = document.getElementById('setting-wd-url');
        const wdUserInput = document.getElementById('setting-wd-user');
        const wdPassInput = document.getElementById('setting-wd-pass');
        const wdDirInput = document.getElementById('setting-wd-dir');

        if (wdUrlInput) wdUrlInput.value = appSettings.wdUrl || "";
        if (wdUserInput) wdUserInput.value = appSettings.wdUser || "";
        if (wdPassInput) wdPassInput.value = appSettings.wdPass || "";
        if (wdDirInput) wdDirInput.value = appSettings.wdDir || "/MarkNotes/";

        // 3. 强制切换到“绑定与数据安全”标签页
        // 先隐藏所有标签内容
        document.querySelectorAll('.setting-tab-content').forEach(el => el.style.display = 'none');
        // 显示 account 标签
        const accountTab = document.getElementById('tab-account');
        if (accountTab) accountTab.style.display = 'block';
        
        // 更新导航栏激活状态
        document.querySelectorAll('.setting-nav-item').forEach(el => el.classList.remove('active'));
        const accountNav = document.querySelector('.setting-nav-item[onclick*="account"]');
        if (accountNav) accountNav.classList.add('active');

        // 4. 显示模态框
        modal.style.display = 'flex';
    };

    window.closeSettingsModal = function() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    };

    window.saveBindingSettings = function() {
        try { 
            const autosaveInput = document.getElementById('setting-autosave');
            const syncScrollCheck = document.getElementById('setting-sync-scroll');
            const themeSelect = document.getElementById('setting-theme'); 
            
            if (autosaveInput) {
                let val = parseInt(autosaveInput.value);
                if (val >= 1 && val <= 3600) {
                    appSettings.autoSaveInterval = val;
                }
            }
            if (syncScrollCheck) {
                appSettings.syncScroll = syncScrollCheck.checked;
            }

            if (themeSelect) {
                appSettings.theme = themeSelect.value;
                applyTheme(appSettings.theme); 
            }

            const ghTokenInput = document.getElementById('setting-gh-token');
            const ghOwnerInput = document.getElementById('setting-gh-owner');
            const ghRepoInput = document.getElementById('setting-gh-repo');
            const ghBranchInput = document.getElementById('setting-gh-branch');

            if (ghTokenInput) appSettings.ghToken = ghTokenInput.value.trim();
            if (ghOwnerInput) appSettings.ghOwner = ghOwnerInput.value.trim();
            if (ghRepoInput) appSettings.ghRepo = ghRepoInput.value.trim();
            if (ghBranchInput) appSettings.ghBranch = ghBranchInput.value.trim() || "main";

            const wdUrlInput = document.getElementById('setting-wd-url');
            const wdUserInput = document.getElementById('setting-wd-user');
            const wdPassInput = document.getElementById('setting-wd-pass');
            const wdDirInput = document.getElementById('setting-wd-dir');

            if (wdUrlInput) {
                let url = wdUrlInput.value.trim();
                if (url && !url.endsWith('/')) url += '/';
                appSettings.wdUrl = url;
            }
            if (wdUserInput) appSettings.wdUser = wdUserInput.value.trim();
            if (wdPassInput) appSettings.wdPass = wdPassInput.value; 
            if (wdDirInput) {
                let dir = wdDirInput.value.trim();
                if (dir && !dir.startsWith('/')) dir = '/' + dir;
                if (dir && !dir.endsWith('/')) dir += '/';
                appSettings.wdDir = dir || "/MarkNotes/";
            }

            saveSettings();

            startAutoSaveTimer();
            initScrollSync(); 

            closeSettingsModal();
            showToast("所有配置已保存并生效", "success");
        } catch (err) {
            console.error("保存设置失败:", err);
            showToast("保存失败: " + err.message, "error");
        }
    };

    // 2. 构造 WebDAV 基础认证头
    function getWebDavAuthHeader() {
        if (!appSettings.wdUser || !appSettings.wdPass) return null;
        try {
            const auth = btoa(`${appSettings.wdUser}:${appSettings.wdPass}`);
            return `Basic ${auth}`;
        } catch (e) { return null; }
    }


    // 4. 上传单个文件到 WebDAV
    async function uploadFileToWebDav(localPath, remoteName) {
        try {
            const content = await Neutralino.filesystem.readFile(localPath);
            const baseUrl = appSettings.wdUrl.replace(/\/$/, '');
            const remoteUrl = `${baseUrl}${appSettings.wdDir}${remoteName}`;

            const response = await Neutralino.net.fetch(remoteUrl, {
                method: 'PUT',
                headers: { 'Authorization': getWebDavAuthHeader() },
                body: content
            });

            return response.status >= 200 && response.status < 300;
        } catch (err) {
            console.error(`上传失败 [${remoteName}]:`, err);
            return false;
        }
    }

    // 5. 全量同步
    window.syncAllToWebDav = async function() {
        if (!appSettings.wdUrl || !appSettings.wdUser) {
            showToast("请先配置并保存 WebDAV 信息", "error");
            return;
        }

        showToast("开始全量同步，请稍候...", "info");
        let successCount = 0;
        let failCount = 0;

        try {
            const files = await getAllMarkdownFiles(DATA_DIR_ROOT);
            if (files.length === 0) {
                showToast("未找到任何 .md 文件", "info");
                return;
            }

            for (const filePath of files) {
                const relativePath = filePath.replace(DATA_DIR_ROOT + '/', '').replace(/\\/g, '/');
                const isSuccess = await uploadFileToWebDav(filePath, relativePath);
                if (isSuccess) successCount++;
                else failCount++;
            }
            
            showToast(`同步完成：成功 ${successCount} 个，失败 ${failCount} 个`, successCount > 0 ? "success" : "error");
        } catch (err) {
            showToast("同步出错: " + err.message, "error");
        }
    };

    async function getAllMarkdownFiles(dirPath) {
        let results = [];
        try {
            const entries = await Neutralino.filesystem.readDirectory(dirPath);
            for (const entry of entries) {
                const name = entry.entryName || entry.entry;
                if (name === '.Trash' || name === 'skins') continue;
                const fullPath = `${dirPath}/${name}`;
                if (entry.type === 'DIRECTORY') {
                    results = results.concat(await getAllMarkdownFiles(fullPath));
                } else if (name.endsWith('.md')) {
                    results.push(fullPath);
                }
            }
        } catch (e) {}
        return results;
    }


    window.uploadImageToGithub = async function(file) {
        if (!appSettings.ghToken || !appSettings.ghOwner || !appSettings.ghRepo) {
            showToast("请先在设置中配置图床", "error");
            return null;
        }

        try {
            showToast("正在检查图片状态", "info");
            const base64Data = await readFileAsBase64(file);
            const content = base64Data.split(',')[1];
            const remotePath = generateRemotePath(file.name);
            
            let sha = null;
            try {
                const checkResponse = await MarkNet.githubRequest(remotePath, 'GET');
                if (checkResponse.ok) {
                    const existingData = await checkResponse.json();
                    sha = existingData.sha;
                    console.log("文件已存在，获取到 SHA:", sha);
                }
            } catch (e) {
                console.log("文件不存在，将执行新建操作");
            }

            showToast("正在上传图片", "info");
            
            // 2. 构造 PUT 请求的 Body
            const putBody = {
                message: `Upload via Mark Editor: ${file.name}`,
                content: content,
                branch: appSettings.ghBranch
            };
            
            // 3. 如果文件已存在
            if (sha) {
                putBody.sha = sha;
            }

            // 4. 发送 PUT 请求
            const response = await MarkNet.githubRequest(remotePath, 'PUT', putBody);

            const result = await response.json();
            if (result.content && result.content.download_url) {
                showToast("与 Github 的链接成功", "success");
                return result.content.download_url;
            } else {
                showToast("上传终止: " + (result.message || "未知错误"), "error");
                return null;
            }
        } catch (err) {
            showToast("上传终止: " + err.message, "error");
            return null;
        }
    };

    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function generateRemotePath(fileName) {
        let path = appSettings.ghPathTemplate;
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        let mdName = "unknown";
        if (currentFilePath) mdName = currentFilePath.split('/').pop().replace(/\.[^/.]+$/, "");
        
        path = path.replace('{YYYY}', yyyy).replace('{MM}', mm).replace('{DD}', dd).replace('{MDNAME}', mdName);
        if (!path.endsWith('/')) path += '/';
        return `${path}${fileName}`;
    }
    
    // 配置备份与恢复 (保持简洁)
    window.backupSettings = async function() {
        try {
            const result = await Neutralino.os.showSaveDialog("备份 Mark 设置", { filters: [{ name: "JSON Files", extensions: ["json"] }] });
            if (result) {
                await Neutralino.filesystem.writeFile(result, JSON.stringify(appSettings, null, 2));
                showToast("设置备份成功！", "success");
            }
        } catch (err) { showToast("备份失败", "error"); }
    };

    window.restoreSettings = async function() {
        try {
            const result = await Neutralino.os.showOpenDialog("恢复 Mark 设置", { filters: [{ name: "JSON Files", extensions: ["json"] }] });
            if (result && result.length > 0) {
                const content = await Neutralino.filesystem.readFile(result[0]);
                appSettings = { ...appSettings, ...JSON.parse(content) };
                applyTheme(appSettings.theme);
                startAutoSaveTimer();
                await saveSettings();
                showToast("设置已恢复", "success");
            }
        } catch (err) { showToast("恢复失败", "error"); }
    };

    // 自定义皮肤导入
    window.importCustomSkin = async function() {
        try {
            const result = await Neutralino.os.showOpenDialog("选择 CSS 皮肤文件", { filters: [{ name: "CSS Files", extensions: ["css"] }] });
            if (result && result.length > 0) {
                const sourcePath = result[0];
                const fileName = sourcePath.split(/[/\\]/).pop();
                const skinsDir = `${DATA_DIR_ROOT}/skins`;
                await Neutralino.filesystem.createDirectory(skinsDir).catch(() => {});
                const content = await Neutralino.filesystem.readFile(sourcePath);
                await Neutralino.filesystem.writeFile(`${skinsDir}/${fileName}`, content);
                showToast(`皮肤 "${fileName}" 导入成功！`, "success");
                applyCustomSkin(fileName);
                appSettings.theme = `custom:${fileName}`; 
                saveSettings();
            }
        } catch (err) { showToast(`导入失败: ${err.message}`, "error"); }
    };

    window.applyCustomSkin = async function(fileName) {
        try {
            const skinPath = `${DATA_DIR_ROOT}/skins/${fileName}`;
            const content = await Neutralino.filesystem.readFile(skinPath);
            let customStyle = document.getElementById('custom-skin-style');
            if (!customStyle) {
                customStyle = document.createElement('style');
                customStyle.id = 'custom-skin-style';
                document.head.appendChild(customStyle);
            }
            customStyle.innerHTML = content;
        } catch (err) { showToast("应用皮肤失败", "error"); }
    };

    // 关于页面辅助弹窗
    function showGlobalInfoModal(title, contentHtml, btnText = '关闭') {
        const oldModal = document.getElementById('global-info-modal');
        if (oldModal) oldModal.remove();
        const modal = document.createElement('div');
        modal.id = 'global-info-modal';
        modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.4); display: flex; justify-content: center; align-items: center; z-index: 99999;`;
        modal.innerHTML = `<div style="background: var(--winui-bg-primary, #fff); color: var(--winui-text-primary, #000); width: 450px; max-height: 80vh; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); display: flex; flex-direction: column; overflow: hidden;"><div style="padding: 20px; font-size: 18px; font-weight: 600; border-bottom: 1px solid var(--winui-border-light, #eee);">${title}</div><div style="padding: 20px; overflow-y: auto; flex: 1; font-size: 14px; line-height: 1.6;">${contentHtml}</div><div style="padding: 15px 20px; border-top: 1px solid var(--winui-border-light, #eee); text-align: right;"><button id="global-modal-close-btn" style="padding: 6px 20px; border-radius: 4px; border: 1px solid var(--winui-border-light, #ccc); background: var(--winui-accent, #005fb8); color: #fff; cursor: pointer; font-size: 14px;">${btnText}</button></div></div>`;
        document.body.appendChild(modal);
        modal.querySelector('#global-modal-close-btn').onclick = () => modal.remove();
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    }

    window.showPrivacyPolicy = function() { showGlobalInfoModal("隐私政策", "<div style='text-align:left; font-size:13px; line-height:1.6;'><p>1. Mark 是一款本地 Markdown 编辑器，所有数据均存储在您的本地设备上。</p><p>2. 我们不会收集、上传或共享您的任何笔记内容以及个人信息。</p><p>3. 软件仅在您主动点击“检查更新”、“打开外部链接”、“执行云备份”时才会进行联网操作。</p></div>", "我知道了"); };
    window.showDependencies = function() { showGlobalInfoModal("依赖项说明", "<div style='text-align:left; font-size:13px; line-height:1.6;'><ul style='padding-left: 20px;'><li><strong>Neutralino:</strong> 跨平台轻量级应用框架</li><li><strong>Microsoft Edge Webview2:</strong> 运行 Mark 的必要依赖项</li><li><strong>CodeMirror:</strong> 浏览器端代码编辑器</li><li><strong>Marked:</strong> Markdown 解析器</li></ul></div>", "确认"); };

    // 拖拽调整区域大小逻辑
    function initResizers() {
        const sidebar = document.getElementById('sidebar');
        const editorContainer = document.getElementById('editor-container');
        const dragSidebar = document.getElementById('drag-sidebar');
        const dragPreview = document.getElementById('drag-preview');
        let isDragging = false, currentResizer = null, startX = 0, startWidthSidebar = 0, startWidthEditor = 0;
        function onMouseDown(e, resizerType) {
            isDragging = true; currentResizer = resizerType; startX = e.clientX;
            if (resizerType === 'sidebar') startWidthSidebar = sidebar.offsetWidth;
            else if (resizerType === 'preview') startWidthEditor = editorContainer.offsetWidth;
            document.body.classList.add('resizing'); document.body.style.cursor = 'col-resize'; e.preventDefault();
        }
        dragSidebar.addEventListener('mousedown', (e) => onMouseDown(e, 'sidebar'));
        dragPreview.addEventListener('mousedown', (e) => onMouseDown(e, 'preview'));
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            if (currentResizer === 'sidebar') {
                const newWidth = startWidthSidebar + dx;
                if (newWidth >= 180 && newWidth <= window.innerWidth * 0.5) sidebar.style.width = `${newWidth}px`;
            } else if (currentResizer === 'preview') {
                const newWidth = startWidthEditor + dx;
                if (newWidth >= 200 && newWidth <= window.innerWidth * 0.8) editorContainer.style.width = `${newWidth}px`;
            }
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) { isDragging = false; currentResizer = null; document.body.classList.remove('resizing'); document.body.style.cursor = ''; if (editor) editor.refresh(); }
        });
    }
    setTimeout(initResizers, 500); 

    // 插入图片链接
    window.insertImageLink = async function() {
        if (!currentFilePath || editor.getOption("readOnly")) { showToast("你要把图片插入到空气里吗", "error"); return; }
        const modal = document.getElementById('custom-modal');
        const titleEl = document.getElementById('modal-title');
        const msgEl = document.getElementById('modal-message');
        const inputEl = document.getElementById('modal-input');
        const confirmBtn = document.getElementById('modal-confirm-btn');
        const cancelBtn = document.getElementById('modal-cancel-btn');
        const originalTitle = titleEl.innerText; const originalMsg = msgEl.innerText; const originalInputDisplay = inputEl.style.display; const originalConfirmText = confirmBtn.innerText; const originalConfirmOnClick = confirmBtn.onclick;
        titleEl.innerText = "插入图片";
        msgEl.innerHTML = `<div style="margin-bottom: 10px; font-size: 13px; color: var(--winui-text-secondary);">请输入图片 URL，或本地上传。</div><button id="btn-upload-local" class="winui-btn secondary" style="width: 100%; margin-bottom: 10px;">上传图片</button><div id="upload-status" style="font-size: 12px; color: #0067c0; display: none;"></div>`;
        inputEl.style.display = 'block'; inputEl.placeholder = "https://example.com/image.png"; inputEl.value = ""; confirmBtn.innerText = "确认插入"; cancelBtn.style.display = 'block';
        const uploadBtn = document.getElementById('btn-upload-local'); const statusDiv = document.getElementById('upload-status');
        uploadBtn.onclick = async () => {
            if (!appSettings.ghToken || !appSettings.ghOwner || !appSettings.ghRepo) { showToast("请先在设置中配置 GitHub 图床信息", "error"); openSettingsModal(); return; }
            const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = 'image/png, image/jpeg, image/gif, image/webp';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0]; if (!file) return;
                uploadBtn.disabled = true; uploadBtn.innerText = "上传中..."; statusDiv.style.display = 'block'; statusDiv.innerText = "正在与 GitHub 链接";
                try {
                    const url = await uploadImageToGithub(file);
                    if (url) { inputEl.value = url; statusDiv.innerText = "已获取图片链接。"; statusDiv.style.color = "green"; inputEl.focus(); }
                    else { statusDiv.innerText = "图片拉取失败，请查看日志文件。"; statusDiv.style.color = "red"; }
                } catch (err) { statusDiv.innerText = "未知错误: " + err.message; statusDiv.style.color = "red"; }
                finally { uploadBtn.disabled = false; uploadBtn.innerText = "上传图片"; }
            };
            fileInput.click();
        };
        confirmBtn.onclick = () => {
            const url = inputEl.value.trim();
            if (url) {
                let fileName = "image"; try { fileName = url.split('/').pop().split('?')[0] || "image"; if (fileName.length > 20) fileName = fileName.substring(0, 20) + "..."; } catch(e) {}
                editor.replaceSelection(`![${fileName}](${url})`); renderPreview(editor.getValue()); closeModal(null);
            } else { showToast("请输入有效的图片链接", "error"); }
        };
        const restoreModal = () => { titleEl.innerText = originalTitle; msgEl.innerText = originalMsg; inputEl.style.display = originalInputDisplay; confirmBtn.innerText = originalConfirmText; confirmBtn.onclick = originalConfirmOnClick; };
        const oldClose = closeModal;
        closeModal = function(result) { restoreModal(); oldClose(result); setTimeout(() => { closeModal = oldClose; }, 100); };
        modal.style.display = 'flex'; setTimeout(() => inputEl.focus(), 100);
    };

    // 插入超链接
    window.insertHyperlink = async function() {
        if (!currentFilePath || editor.getOption("readOnly")) { showToast("你要把超链接插入到空气里吗", "error"); return; }
        const selection = editor.getSelection(); const defaultText = selection || "链接文字";
        const url = await showCustomDialog("插入链接", "点击超链接文字后打开的地址 (URL):", "https://");
        if (url) {
            const text = await showCustomDialog("显示文字", "超链接显示的文字:", defaultText);
            editor.replaceSelection(`[${text}](${url})`); editor.focus(); renderPreview(editor.getValue()); showToast("超链接已插入", "success");
        }
    };

    // 设置窗口 Tab 切换
    window.switchSettingTab = function(tabName, element) {
        document.querySelectorAll('.setting-tab-content').forEach(el => el.style.display = 'none');
        const targetTab = document.getElementById('tab-' + tabName);
        if (targetTab) targetTab.style.display = 'block';
        document.querySelectorAll('.setting-nav-item').forEach(el => el.classList.remove('active'));
        if (element) element.classList.add('active');
    };

    async function updateLocalUsername() {
        try {
            const result = await Neutralino.os.execCommand('whoami');
            const username = result.stdOut.trim().split('\\').pop();
            document.getElementById('local-username-display').innerText = username || "Local User";
        } catch (e) { document.getElementById('local-username-display').innerText = "Local User"; }
    }

    window.confirmResetApp = async function() {
        const confirmed = await showCustomDialog("危险操作", "确定要清空所有笔记和设置吗？此操作不可恢复！", "", true);
        if (confirmed !== null) {
            try {
                const entries = await Neutralino.filesystem.readDirectory(DATA_DIR_ROOT);
                for (const entry of entries) {
                    const name = entry.entryName || entry.entry;
                    if (name !== '.Trash') {
                        const path = `${DATA_DIR_ROOT}/${name}`;
                        if (entry.type !== 'DIRECTORY') await Neutralino.filesystem.removeFile(path);
                    }
                }
                showToast("数据已清空，即将重启...", "success");
                setTimeout(() => Neutralino.app.exit(), 1500);
            } catch (err) { showToast("清空失败: " + err.message, "error"); }
        }
    };

    // 状态栏增强功能
    let sessionStartTime = Date.now();
    let usageTimer = null;
    function updateStatusBar() {
        if (!editor) return;
        const cursor = editor.getCursor();
        const content = editor.getValue();
        const selection = editor.getSelection();
        document.getElementById('stat-cursor').innerText = `行 ${cursor.line + 1}, 列 ${cursor.ch + 1}`;
        const charCount = content.length;
        const wordCount = content.trim() === "" ? 0 : content.trim().split(/\s+/).length;
        document.getElementById('stat-chars').innerText = `字符: ${charCount}`;
        document.getElementById('stat-words').innerText = `字数: ${wordCount}`;
        document.getElementById('stat-selected').innerText = `已选中: ${selection.length}`;
        if (!usageTimer) {
            usageTimer = setInterval(() => {
                const diff = Math.floor((Date.now() - sessionStartTime) / 1000);
                const mins = Math.floor(diff / 60).toString().padStart(2, '0');
                const secs = (diff % 60).toString().padStart(2, '0');
                document.getElementById('stat-time').innerText = `用时: ${mins}:${secs}`;
            }, 1000);
        }
    }
    editor.on("change", updateStatusBar);
    editor.on("cursorActivity", updateStatusBar);
    setTimeout(updateStatusBar, 500);

    // 按钮功能实现
    window.toggleSidebar = function() {
        const sidebar = document.getElementById('sidebar');
        const resizer = document.querySelector('.resizer');
        if (sidebar.style.display === 'none') { sidebar.style.display = 'flex'; if (resizer) resizer.style.display = 'block'; }
        else { sidebar.style.display = 'none'; if (resizer) resizer.style.display = 'none'; }
    };

    window.toggleEditor = function() {
        const editorContainer = document.getElementById('editor-container');
        const preview = document.getElementById('preview');
        if (editorContainer.style.display === 'none') { editorContainer.style.display = 'block'; editorContainer.style.width = '50%'; preview.style.display = 'block'; }
        else { editorContainer.style.display = 'none'; preview.style.width = '100%'; }
    };

    window.openOutlineModal = function() {
        if (!currentFilePath) { showToast("你要查看空气的章节吗", "info"); return; }
        const content = editor.getValue();
        const headings = [];
        const lines = content.split('\n');
        lines.forEach((line, index) => {
            const match = line.match(/^(#{1,6})\s+(.*)/);
            if (match) headings.push({ level: match[1].length, text: match[2], line: index });
        });
        if (headings.length === 0) { showToast("此文章无章节，要创建章节，使用“#”", "info"); return; }
        let html = '<ul style="list-style:none; padding:0; margin:0;">';
        headings.forEach(h => {
            const indent = (h.level - 1) * 15;
            html += `<li style="padding: 6px 10px ${6}px ${indent + 10}px; cursor:pointer; border-radius:4px; hover:bg-gray-100;" onmouseover="this.style.background='rgba(0,0,0,0.05)'" onmouseout="this.style.background='transparent'" onclick="jumpToLine(${h.line}); closeModal(null);"><span style="color:#888; font-size:11px; margin-right:8px;">H${h.level}</span>${h.text}</li>`;
        });
        html += '</ul>';
        const modal = document.getElementById('custom-modal');
        document.getElementById('modal-title').innerText = "文章大纲";
        document.getElementById('modal-message').innerHTML = html;
        document.getElementById('modal-input').style.display = 'none';
        document.getElementById('modal-cancel-btn').style.display = 'none';
        document.getElementById('modal-confirm-btn').innerText = '关闭';
        document.getElementById('modal-confirm-btn').onclick = () => closeModal(null);
        modal.style.display = 'flex';
    };

    window.jumpToLine = function(line) {
        editor.setCursor({line: line, ch: 0});
        editor.scrollIntoView({line: line, ch: 0}, 200);
        editor.focus();
    };

    window.testWebDavConnection = async function() {
        const urlInput = document.getElementById('setting-wd-url');
        const userInput = document.getElementById('setting-wd-user');
        const passInput = document.getElementById('setting-wd-pass');
        
        const url = urlInput ? urlInput.value.trim() : appSettings.wdUrl;
        const user = userInput ? userInput.value.trim() : appSettings.wdUser;
        const pass = passInput ? passInput.value : appSettings.wdPass;
        
        if (!url || !user) {
            showToast("请先填写服务器地址和用户名", "error");
            return;
        }

        showToast("正在通过原生网络层连接 WebDAV...", "info");
        
        try {
            // 使用 Neutralino 原生 API
            const response = await Neutralino.net.fetch(url, {
                method: 'PROPFIND',
                headers: {
                    'Authorization': 'Basic ' + btoa(user + ':' + pass),
                    'Depth': '1',
                    'Content-Type': 'application/xml'
                },
                body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>'
            });

            console.log("WebDAV Native Status:", response.status);

            if (response.status === 207 || response.status === 200) {
                showToast("已与 WebDav 服务器完成链接", "success");
            } else if (response.status === 401) {
                showToast("认证失败：请检查用户名或应用密码", "error");
            } else if (response.status === 404) {
                showToast("路径错误：服务器未找到该地址", "error");
            } else {
                showToast(`异常状态码: HTTP ${response.status}`, "error");
            }
        } catch (err) {
            console.error("WebDAV Native Error:", err);
            showToast("网络请求失败: " + err.message, "error");
        }
    };

    window.backupToWebDav = async function() {
        saveBindingSettings();
        
        showToast("正在与云服务器链接", "info");
        
        if (typeof window.syncAllToWebDav === 'function') {
            await window.syncAllToWebDav();
        } else {
            showToast("备份插件未加载", "error");
        }
    };

    document.body.classList.add('loaded');
    
    initSystemDir();
});

