/**
 * Nano Banana Watermark Remover
 * 使用 Reverse Alpha Blending 技術移除浮水印
 */

// ===== Global State =====
const state = {
    masks: new Map(), // Map<size, {image, canvas, ctx, imageData, margin}>
    processedImages: [],
    isProcessing: false,
    // Lightbox state
    lightbox: {
        isOpen: false,
        currentIndex: 0,
        showingOriginal: false
    }
};

// ===== DOM Elements =====
const DOM = {
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    statusBar: document.getElementById('statusBar'),
    statusText: document.getElementById('statusText'),
    statusCount: document.getElementById('statusCount'),
    progressFill: document.getElementById('progressFill'),
    resultsSection: document.getElementById('resultsSection'),
    resultsGrid: document.getElementById('resultsGrid'),
    clearBtn: document.getElementById('clearBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    // Lightbox elements
    lightbox: document.getElementById('lightbox'),
    lightboxClose: document.getElementById('lightboxClose'),
    lightboxImage: document.getElementById('lightboxImage'),
    lightboxImageContainer: document.getElementById('lightboxImageContainer'),
    lightboxHint: document.getElementById('lightboxHint'),
    lightboxFilename: document.getElementById('lightboxFilename'),
    toggleProcessed: document.getElementById('toggleProcessed'),
    toggleOriginal: document.getElementById('toggleOriginal'),
    lightboxPrev: document.getElementById('lightboxPrev'),
    lightboxNext: document.getElementById('lightboxNext'),
    // Theme toggle
    themeToggle: document.getElementById('themeToggle')
};

// ===== Mask Configuration =====
// margin: 浮水印距離右下角的邊距
const MASK_CONFIGS = [
    { size: 96, path: 'assets/mask_96.png', margin: 64 },
    { size: 48, path: 'assets/mask_48.png', margin: 32 }
];

// ===== Web Worker =====
let worker = null;

// ===== Initialize =====
async function init() {
    initTheme();
    initWorker();
    registerServiceWorker();
    await loadMasks();
    await initMasksInWorker();
    setupEventListeners();
    console.log('🍌 Nano Banana Watermark Remover initialized');
}

/**
 * 把所有 mask 傳給 worker (一次性，後續處理只需傳圖片資料)
 */
function initMasksInWorker() {
    const promises = [];
    for (const [size, mask] of state.masks.entries()) {
        promises.push(new Promise((resolve) => {
            const handler = (e) => {
                if (e.data.type === 'maskReady' && e.data.size === size) {
                    worker.removeEventListener('message', handler);
                    resolve();
                }
            };
            worker.addEventListener('message', handler);
            // 用複本傳給 worker，主線程仍保留 mask 供 selectMask 等使用
            const maskDataCopy = new Uint8ClampedArray(mask.imageData.data);
            worker.postMessage({
                type: 'initMask',
                data: {
                    size,
                    maskData: maskDataCopy,
                    maskWidth: mask.width,
                    maskHeight: mask.height,
                    margin: mask.margin
                }
            }, [maskDataCopy.buffer]);
        }));
    }
    return Promise.all(promises);
}

/**
 * 初始化 Web Worker
 */
function initWorker() {
    worker = new Worker('worker.js');
    console.log('🔧 Web Worker initialized');
}

/**
 * 註冊 Service Worker (PWA)
 */
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('📱 Service Worker registered'))
            .catch(err => console.warn('Service Worker registration failed:', err));
    }
}

/**
 * 初始化主題設定
 */
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    }
    // 如果沒有儲存的主題，則依賴系統偏好 (CSS media query 會處理)
}

/**
 * 切換主題
 */
function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    let newTheme;
    if (currentTheme === 'light') {
        newTheme = 'dark';
    } else if (currentTheme === 'dark') {
        newTheme = 'light';
    } else {
        // 目前跟隨系統，切換到相反
        newTheme = prefersDark ? 'light' : 'dark';
    }
    
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    console.log(`🌙 Theme changed to: ${newTheme}`);
}

/**
 * 載入所有 mask 圖片並預處理 alpha 通道
 * mask 是黑底的圖片，白色區域為浮水印，需要提取亮度作為 alpha
 */
async function loadMasks() {
    const loadPromises = MASK_CONFIGS.map(async (config) => {
        try {
            const image = await loadImage(config.path);
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            const rawImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            
            // 預處理：從 RGB 亮度提取 alpha 通道
            // mask 是黑底白字，白色 = 浮水印區域
            const processedData = preprocessMask(rawImageData);
            
            state.masks.set(config.size, {
                image,
                canvas,
                ctx,
                imageData: processedData,
                width: image.width,
                height: image.height,
                margin: config.margin
            });
            
            console.log(`✓ Loaded mask: ${config.size}x${config.size} (margin: ${config.margin}px)`);
        } catch (error) {
            console.error(`✗ Failed to load mask: ${config.path}`, error);
        }
    });
    
    await Promise.all(loadPromises);
}

/**
 * 預處理 mask：從 RGB 亮度提取 alpha 值
 * 輸入：黑底白字的圖片
 * 輸出：RGB 為白色 (255,255,255)，alpha 為亮度值
 * 
 * @param {ImageData} imageData - 原始 mask ImageData
 * @returns {ImageData} 處理後的 ImageData
 */
function preprocessMask(imageData) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    
    // 創建新的 ImageData
    const processed = new ImageData(width, height);
    const output = processed.data;
    
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        
        // 計算亮度作為 alpha (使用 luminance 公式)
        // 白色 (255,255,255) → alpha = 255
        // 黑色 (0,0,0) → alpha = 0
        const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        
        // 設置 RGB 為白色（浮水印顏色），alpha 為亮度
        output[i] = 255;     // R - 浮水印是白色
        output[i + 1] = 255; // G
        output[i + 2] = 255; // B
        output[i + 3] = luminance; // Alpha
    }
    
    return processed;
}

/**
 * 載入圖片並返回 Promise
 * @param {string} src - 圖片路徑
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
        img.src = src;
    });
}

// ===== Event Listeners =====
function setupEventListeners() {
    // Drop zone click
    DOM.dropZone.addEventListener('click', () => DOM.fileInput.click());
    
    // File input change
    DOM.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            processFiles(Array.from(e.target.files));
        }
    });
    
    // Drag and drop
    DOM.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        DOM.dropZone.classList.add('drag-over');
    });
    
    DOM.dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        DOM.dropZone.classList.remove('drag-over');
    });
    
    DOM.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        DOM.dropZone.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files).filter(file => 
            file.type === 'image/png' || file.type === 'image/jpeg'
        );
        
        if (files.length > 0) {
            processFiles(files);
        }
    });
    
    // Clear button
    DOM.clearBtn.addEventListener('click', clearResults);
    
    // Download all button
    DOM.downloadAllBtn.addEventListener('click', downloadAll);
    
    // Close lightbox on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.lightbox.isOpen) {
            closeLightbox();
        }
        // Lightbox navigation with arrow keys
        if (state.lightbox.isOpen) {
            if (e.key === 'ArrowLeft') {
                navigateLightbox(-1);
            } else if (e.key === 'ArrowRight') {
                navigateLightbox(1);
            } else if (e.key === ' ') {
                e.preventDefault();
                toggleOriginalImage();
            }
        }
    });
    
    // Lightbox event listeners
    if (DOM.lightboxClose) {
        DOM.lightboxClose.addEventListener('click', closeLightbox);
    }
    if (DOM.lightbox) {
        DOM.lightbox.addEventListener('click', (e) => {
            if (e.target === DOM.lightbox) {
                closeLightbox();
            }
        });
    }
    if (DOM.lightboxImageContainer) {
        DOM.lightboxImageContainer.addEventListener('click', toggleOriginalImage);
    }
    if (DOM.toggleProcessed) {
        DOM.toggleProcessed.addEventListener('click', () => showProcessedImage());
    }
    if (DOM.toggleOriginal) {
        DOM.toggleOriginal.addEventListener('click', () => showOriginalImage());
    }
    if (DOM.lightboxPrev) {
        DOM.lightboxPrev.addEventListener('click', () => navigateLightbox(-1));
    }
    if (DOM.lightboxNext) {
        DOM.lightboxNext.addEventListener('click', () => navigateLightbox(1));
    }
    
    // Theme toggle
    if (DOM.themeToggle) {
        DOM.themeToggle.addEventListener('click', toggleTheme);
    }
}

// ===== Lightbox Functions =====

/**
 * 開啟燈箱
 * @param {number} index - 圖片索引
 */
function openLightbox(index) {
    if (!DOM.lightbox || index < 0 || index >= state.processedImages.length) return;
    
    const result = state.processedImages[index];
    if (!result.success) return;
    
    state.lightbox.isOpen = true;
    state.lightbox.currentIndex = index;
    state.lightbox.showingOriginal = false;
    
    updateLightboxImage();
    updateLightboxNav();
    
    DOM.lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    
    // 重置 toggle 按鈕狀態
    DOM.toggleProcessed.classList.add('active');
    DOM.toggleOriginal.classList.remove('active');
    DOM.lightboxImageContainer.classList.remove('showing-original');
}

/**
 * 關閉燈箱
 */
function closeLightbox() {
    if (!DOM.lightbox) return;
    
    state.lightbox.isOpen = false;
    DOM.lightbox.hidden = true;
    document.body.style.overflow = '';
}

/**
 * 更新燈箱圖片
 */
function updateLightboxImage() {
    const result = state.processedImages[state.lightbox.currentIndex];
    if (!result) return;
    
    const imageUrl = state.lightbox.showingOriginal 
        ? result.originalBlobUrl 
        : result.blobUrl;
    
    DOM.lightboxImage.src = imageUrl;
    DOM.lightboxImage.alt = result.filename;
    DOM.lightboxFilename.textContent = state.lightbox.showingOriginal 
        ? `${result.originalName} (原圖)`
        : result.filename;
}

/**
 * 更新燈箱導覽按鈕狀態
 */
function updateLightboxNav() {
    if (DOM.lightboxPrev) {
        DOM.lightboxPrev.disabled = state.lightbox.currentIndex <= 0;
    }
    if (DOM.lightboxNext) {
        DOM.lightboxNext.disabled = state.lightbox.currentIndex >= state.processedImages.length - 1;
    }
}

/**
 * 導覽燈箱
 * @param {number} direction - 方向 (-1: 上一張, 1: 下一張)
 */
function navigateLightbox(direction) {
    const newIndex = state.lightbox.currentIndex + direction;
    
    // 跳過失敗的圖片
    let targetIndex = newIndex;
    while (targetIndex >= 0 && targetIndex < state.processedImages.length) {
        if (state.processedImages[targetIndex].success) {
            break;
        }
        targetIndex += direction;
    }
    
    if (targetIndex >= 0 && targetIndex < state.processedImages.length && state.processedImages[targetIndex].success) {
        state.lightbox.currentIndex = targetIndex;
        state.lightbox.showingOriginal = false;
        
        updateLightboxImage();
        updateLightboxNav();
        
        // 重置 toggle 按鈕
        DOM.toggleProcessed.classList.add('active');
        DOM.toggleOriginal.classList.remove('active');
        DOM.lightboxImageContainer.classList.remove('showing-original');
    }
}

/**
 * 切換顯示原圖/處理後圖片
 */
function toggleOriginalImage() {
    state.lightbox.showingOriginal = !state.lightbox.showingOriginal;
    
    if (state.lightbox.showingOriginal) {
        showOriginalImage();
    } else {
        showProcessedImage();
    }
}

/**
 * 顯示原圖
 */
function showOriginalImage() {
    state.lightbox.showingOriginal = true;
    updateLightboxImage();
    
    DOM.toggleOriginal.classList.add('active');
    DOM.toggleProcessed.classList.remove('active');
    DOM.lightboxImageContainer.classList.add('showing-original');
}

/**
 * 顯示處理後圖片
 */
function showProcessedImage() {
    state.lightbox.showingOriginal = false;
    updateLightboxImage();
    
    DOM.toggleProcessed.classList.add('active');
    DOM.toggleOriginal.classList.remove('active');
    DOM.lightboxImageContainer.classList.remove('showing-original');
}

// ===== Image Processing =====

/**
 * 批次處理圖片
 * @param {File[]} files - 檔案陣列
 */
async function processFiles(files) {
    if (state.isProcessing) return;
    
    state.isProcessing = true;
    showStatus();
    
    let processed = 0;
    const total = files.length;
    
    for (const file of files) {
        updateStatus(`處理中: ${file.name}`, processed, total);
        
        try {
            const result = await processImage(file);
            state.processedImages.push(result);
            addResultCard(result);
        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
            state.processedImages.push({
                filename: file.name,
                error: error.message,
                success: false
            });
            addResultCard({
                filename: file.name,
                error: error.message,
                success: false
            });
        }
        
        processed++;
        updateProgress(processed / total);
    }
    
    updateStatus('處理完成', total, total);
    state.isProcessing = false;
    showResults();
    
    // Reset file input
    DOM.fileInput.value = '';
    
    // Hide status after delay
    setTimeout(() => {
        DOM.statusBar.hidden = true;
    }, 2000);
}

/**
 * 處理單張圖片 (使用 Web Worker)
 * @param {File} file - 圖片檔案
 * @returns {Promise<Object>} 處理結果
 */
async function processImage(file) {
    const image = await loadImageFromFile(file);

    // 找到合適的 mask
    const mask = selectMask(image.width, image.height);
    if (!mask) {
        throw new Error('找不到合適的 mask');
    }

    // 保留輸入格式 (PNG 或 JPEG)
    const outputMime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const outputExt = outputMime === 'image/jpeg' ? 'jpg' : 'png';
    const jpegQuality = 0.95;

    // 原圖 Blob 就是 File 本身 (省一次 encode)
    const originalBlob = file;

    // 創建 canvas 進行處理
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    // 取得原圖 ImageData
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // 偵測浮水印 (transfer imageData buffer 到 worker)
    let imgBytes = imageData.data;
    const detect = await detectWatermarkWithWorker(imgBytes, mask.width, canvas.width, canvas.height);
    imgBytes = detect.imageData; // worker transfer 回來的同一份 buffer

    if (!detect.hasWatermark) {
        return {
            filename: `clear_${file.name}`,
            originalName: file.name,
            blob: originalBlob,
            originalBlob,
            width: image.width,
            height: image.height,
            maskSize: mask.width,
            margin: mask.margin,
            success: true,
            noWatermark: true
        };
    }

    // 使用 Worker 執行 Reverse Alpha Blending (再 transfer 出去一次)
    const processedData = await processImageWithWorker(imgBytes, mask.width, canvas.width, canvas.height);

    // 將結果寫回 canvas
    const newImageData = new ImageData(processedData, canvas.width, canvas.height);
    ctx.putImageData(newImageData, 0, 0);

    // 轉換為 Blob (保留原格式)
    const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, outputMime, outputMime === 'image/jpeg' ? jpegQuality : undefined)
    );

    // 生成檔案名稱：前綴 clear_ 作為識別
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const outputFilename = `clear_${baseName}.${outputExt}`;

    return {
        filename: outputFilename,
        originalName: file.name,
        blob,
        originalBlob,
        width: image.width,
        height: image.height,
        maskSize: mask.width,
        margin: mask.margin,
        success: true,
        noWatermark: false
    };
}

/**
 * 使用 Worker 偵測浮水印 (透過 transfer 不複製 buffer)
 * @returns {Promise<{hasWatermark: boolean, imageData: Uint8ClampedArray}>}
 */
function detectWatermarkWithWorker(imageBytes, maskSize, imgWidth, imgHeight) {
    return new Promise((resolve) => {
        const handler = (e) => {
            if (e.data.type === 'detectResult') {
                worker.removeEventListener('message', handler);
                console.log(`🔍 Worker detection: diff=${e.data.debug?.brightnessDiff?.toFixed(1)}`);
                resolve({ hasWatermark: e.data.hasWatermark, imageData: e.data.imageData });
            }
        };
        worker.addEventListener('message', handler);

        worker.postMessage({
            type: 'detect',
            data: { imageData: imageBytes, maskSize, imgWidth, imgHeight }
        }, [imageBytes.buffer]);
    });
}

/**
 * 使用 Worker 處理圖片 (透過 transfer 不複製 buffer)
 */
function processImageWithWorker(imageBytes, maskSize, imgWidth, imgHeight) {
    return new Promise((resolve) => {
        const handler = (e) => {
            if (e.data.type === 'processResult') {
                worker.removeEventListener('message', handler);
                resolve(e.data.imageData);
            }
        };
        worker.addEventListener('message', handler);

        worker.postMessage({
            type: 'process',
            data: { imageData: imageBytes, maskSize, imgWidth, imgHeight }
        }, [imageBytes.buffer]);
    });
}

/**
 * 從 File 載入圖片
 * @param {File} file - 圖片檔案
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(img.src);
            resolve(img);
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = URL.createObjectURL(file);
    });
}

/**
 * 根據圖片尺寸選擇合適的 mask
 * - 長寬都大於 1024：96px mask
 * - 其他：48px mask
 * 
 * @param {number} width - 圖片寬度
 * @param {number} height - 圖片高度
 * @returns {Object|null} mask 物件
 */
function selectMask(width, height) {
    // 當長寬都大於 1024 時，使用 96px mask
    if (width > 1024 && height > 1024) {
        return state.masks.get(96);
    }
    // 其他使用 48px mask
    return state.masks.get(48);
}

// ===== UI Functions =====

function showStatus() {
    DOM.statusBar.hidden = false;
    DOM.progressFill.style.width = '0%';
}

function updateStatus(text, current, total) {
    DOM.statusText.textContent = text;
    DOM.statusCount.textContent = `${current} / ${total}`;
}

function updateProgress(ratio) {
    DOM.progressFill.style.width = `${ratio * 100}%`;
}

function showResults() {
    if (state.processedImages.length > 0) {
        DOM.resultsSection.hidden = false;
    }
}

function addResultCard(result) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.style.animationDelay = `${state.processedImages.length * 50}ms`;
    
    // 記住當前圖片的索引 (用於開啟燈箱)
    const imageIndex = state.processedImages.length - 1;
    
    if (result.success) {
        const blobUrl = URL.createObjectURL(result.blob);
        // noWatermark 時 result.blob === result.originalBlob，重用同一個 URL
        const originalBlobUrl = result.originalBlob && result.originalBlob !== result.blob
            ? URL.createObjectURL(result.originalBlob)
            : blobUrl;

        const badgeClass = result.noWatermark ? 'no-watermark' : 'success';
        const badgeText = result.noWatermark ? '⚠ 未偵測到浮水印' : '✓ 完成';
        const statusNote = result.noWatermark ? ' · 原圖' : '';

        const imageContainer = document.createElement('div');
        imageContainer.className = 'result-image-container clickable';

        const img = document.createElement('img');
        img.src = blobUrl;
        img.alt = result.filename;
        img.className = 'result-image';

        const badge = document.createElement('span');
        badge.className = `result-badge ${badgeClass}`;
        badge.textContent = badgeText;

        const zoomHint = document.createElement('div');
        zoomHint.className = 'result-zoom-hint';
        zoomHint.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';

        imageContainer.append(img, badge, zoomHint);

        const info = document.createElement('div');
        info.className = 'result-info';

        const filenameDiv = document.createElement('div');
        filenameDiv.className = 'result-filename';
        filenameDiv.title = result.filename;
        filenameDiv.textContent = result.filename;

        const meta = document.createElement('div');
        meta.className = 'result-meta';

        const size = document.createElement('span');
        size.className = 'result-size';
        size.textContent = `${result.width} × ${result.height}${statusNote}`;

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'result-download-btn';
        downloadBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>下載';

        meta.append(size, downloadBtn);
        info.append(filenameDiv, meta);
        card.append(imageContainer, info);

        imageContainer.addEventListener('click', () => openLightbox(imageIndex));
        downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadFile(result.blob, result.filename);
        });

        result.blobUrl = blobUrl;
        result.originalBlobUrl = originalBlobUrl;
    } else {
        const imageContainer = document.createElement('div');
        imageContainer.className = 'result-image-container';
        imageContainer.style.cssText = 'display: flex; align-items: center; justify-content: center;';
        const errIcon = document.createElement('span');
        errIcon.style.cssText = 'color: var(--error); font-size: 2rem;';
        errIcon.textContent = '✗';
        imageContainer.append(errIcon);

        const info = document.createElement('div');
        info.className = 'result-info';

        const filenameDiv = document.createElement('div');
        filenameDiv.className = 'result-filename';
        filenameDiv.title = result.filename;
        filenameDiv.textContent = result.filename;

        const meta = document.createElement('div');
        meta.className = 'result-meta';
        const errMsg = document.createElement('span');
        errMsg.className = 'result-size';
        errMsg.style.color = 'var(--error)';
        errMsg.textContent = result.error;
        meta.append(errMsg);

        info.append(filenameDiv, meta);
        card.append(imageContainer, info);
    }

    DOM.resultsGrid.appendChild(card);
}

/**
 * 下載單一檔案
 * @param {Blob} blob - 檔案 Blob
 * @param {string} filename - 檔案名稱
 */
function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // 延遲釋放 URL 以確保下載開始
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearResults() {
    // 若 lightbox 開著，先關閉避免顯示已 revoke 的破圖
    if (state.lightbox.isOpen) {
        closeLightbox();
    }

    state.processedImages.forEach(result => {
        if (result.blobUrl) {
            URL.revokeObjectURL(result.blobUrl);
        }
        if (result.originalBlobUrl && result.originalBlobUrl !== result.blobUrl) {
            URL.revokeObjectURL(result.originalBlobUrl);
        }
    });

    state.processedImages = [];
    DOM.resultsGrid.innerHTML = '';
    DOM.resultsSection.hidden = true;
}

async function downloadAll() {
    const successfulResults = state.processedImages.filter(r => r.success);
    if (successfulResults.length === 0) return;

    // 單張：直接下載
    if (successfulResults.length === 1) {
        downloadFile(successfulResults[0].blob, successfulResults[0].filename);
        return;
    }

    // 多張：打包成 zip
    if (typeof JSZip === 'undefined') {
        // JSZip 載入失敗 fallback：逐一下載 (可能被瀏覽器阻擋)
        for (let i = 0; i < successfulResults.length; i++) {
            downloadFile(successfulResults[i].blob, successfulResults[i].filename);
            if (i < successfulResults.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
        return;
    }

    const zip = new JSZip();
    // 避免同名衝突
    const usedNames = new Map();
    for (const r of successfulResults) {
        let name = r.filename;
        const count = usedNames.get(name) || 0;
        if (count > 0) {
            const dot = name.lastIndexOf('.');
            name = dot > 0
                ? `${name.slice(0, dot)} (${count})${name.slice(dot)}`
                : `${name} (${count})`;
        }
        usedNames.set(r.filename, count + 1);
        zip.file(name, r.blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadFile(zipBlob, `clear_${stamp}.zip`);
}

// ===== Start Application =====
init();
