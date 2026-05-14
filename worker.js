/**
 * Nano Banana Watermark Remover - Web Worker
 * 處理圖片計算以避免阻塞主線程
 */

// ===== Mask 快取 (避免每次重複傳輸) =====
const masks = new Map(); // size -> { data: Uint8ClampedArray, width, height, margin }

// ===== Worker Message Handler =====
self.onmessage = function(e) {
    const { type, data } = e.data;

    switch (type) {
        case 'initMask':
            masks.set(data.size, {
                data: data.maskData,
                width: data.maskWidth,
                height: data.maskHeight,
                margin: data.margin
            });
            self.postMessage({ type: 'maskReady', size: data.size });
            break;
        case 'process':
            processImage(data);
            break;
        case 'detect':
            detectWatermark(data);
            break;
        default:
            self.postMessage({ type: 'error', error: 'Unknown message type' });
    }
};

/**
 * 偵測圖片是否含有浮水印
 */
function detectWatermark(data) {
    const { imageData, maskSize, imgWidth, imgHeight } = data;
    const mask = masks.get(maskSize);
    if (!mask) {
        self.postMessage({ type: 'detectResult', hasWatermark: false, error: 'mask not loaded' });
        return;
    }

    const imgPixels = imageData;
    const maskPixels = mask.data;
    const maskWidth = mask.width;
    const maskHeight = mask.height;
    const margin = mask.margin;

    const offsetX = imgWidth - maskWidth - margin;
    const offsetY = imgHeight - maskHeight - margin;

    if (offsetX < 0 || offsetY < 0) {
        // 仍把 imageData transfer 回主線程供後續流程使用
        self.postMessage({ type: 'detectResult', hasWatermark: false, imageData }, [imageData.buffer]);
        return;
    }

    let watermarkBrightness = 0;
    let watermarkPixelCount = 0;
    let surroundingBrightness = 0;
    let surroundingPixelCount = 0;

    for (let my = 0; my < maskHeight; my++) {
        for (let mx = 0; mx < maskWidth; mx++) {
            const imgX = offsetX + mx;
            const imgY = offsetY + my;

            if (imgX < 0 || imgY < 0 || imgX >= imgWidth || imgY >= imgHeight) continue;

            const imgIdx = (imgY * imgWidth + imgX) * 4;
            const maskIdx = (my * maskWidth + mx) * 4;

            const alpha = maskPixels[maskIdx + 3] / 255;

            if (alpha > 0.1) {
                const r = imgPixels[imgIdx];
                const g = imgPixels[imgIdx + 1];
                const b = imgPixels[imgIdx + 2];
                const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

                watermarkBrightness += brightness * alpha;
                watermarkPixelCount += alpha;
            }
        }
    }

    const sampleSize = Math.min(maskWidth, maskHeight);

    // 左側參考區域
    for (let y = offsetY; y < offsetY + maskHeight && y < imgHeight; y++) {
        for (let x = Math.max(0, offsetX - sampleSize); x < offsetX && x >= 0; x++) {
            const imgIdx = (y * imgWidth + x) * 4;
            const r = imgPixels[imgIdx];
            const g = imgPixels[imgIdx + 1];
            const b = imgPixels[imgIdx + 2];
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

            surroundingBrightness += brightness;
            surroundingPixelCount++;
        }
    }

    // 上方參考區域
    for (let y = Math.max(0, offsetY - sampleSize); y < offsetY && y >= 0; y++) {
        for (let x = offsetX; x < offsetX + maskWidth && x < imgWidth; x++) {
            const imgIdx = (y * imgWidth + x) * 4;
            const r = imgPixels[imgIdx];
            const g = imgPixels[imgIdx + 1];
            const b = imgPixels[imgIdx + 2];
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

            surroundingBrightness += brightness;
            surroundingPixelCount++;
        }
    }

    const avgWatermarkBrightness = watermarkPixelCount > 0
        ? watermarkBrightness / watermarkPixelCount
        : 0;
    const avgSurroundingBrightness = surroundingPixelCount > 0
        ? surroundingBrightness / surroundingPixelCount
        : 128;

    const brightnessDiff = avgWatermarkBrightness - avgSurroundingBrightness;
    const threshold = 10;

    // 把 imageData transfer 回主線程，後續若要做 process 可重用
    self.postMessage({
        type: 'detectResult',
        hasWatermark: brightnessDiff > threshold,
        imageData,
        debug: { avgWatermarkBrightness, avgSurroundingBrightness, brightnessDiff }
    }, [imageData.buffer]);
}

/**
 * 執行 Reverse Alpha Blending
 */
function processImage(data) {
    const { imageData, maskSize, imgWidth, imgHeight } = data;
    const mask = masks.get(maskSize);
    if (!mask) {
        self.postMessage({ type: 'processResult', error: 'mask not loaded' });
        return;
    }

    const imgPixels = imageData;
    const maskPixels = mask.data;
    const maskWidth = mask.width;
    const maskHeight = mask.height;
    const margin = mask.margin;

    const offsetX = imgWidth - maskWidth - margin;
    const offsetY = imgHeight - maskHeight - margin;

    for (let my = 0; my < maskHeight; my++) {
        for (let mx = 0; mx < maskWidth; mx++) {
            const imgX = offsetX + mx;
            const imgY = offsetY + my;

            if (imgX < 0 || imgY < 0 || imgX >= imgWidth || imgY >= imgHeight) continue;

            const imgIdx = (imgY * imgWidth + imgX) * 4;
            const maskIdx = (my * maskWidth + mx) * 4;

            const alpha = maskPixels[maskIdx + 3] / 255;

            if (alpha > 0.001) {
                const invAlpha = 1 - alpha;

                if (invAlpha > 0.001) {
                    // 浮水印顏色 (白色)
                    const wmR = 255, wmG = 255, wmB = 255;

                    // Reverse Alpha Blending
                    let r = (imgPixels[imgIdx] - wmR * alpha) / invAlpha;
                    let g = (imgPixels[imgIdx + 1] - wmG * alpha) / invAlpha;
                    let b = (imgPixels[imgIdx + 2] - wmB * alpha) / invAlpha;

                    imgPixels[imgIdx] = Math.max(0, Math.min(255, Math.round(r)));
                    imgPixels[imgIdx + 1] = Math.max(0, Math.min(255, Math.round(g)));
                    imgPixels[imgIdx + 2] = Math.max(0, Math.min(255, Math.round(b)));
                }
            }
        }
    }

    self.postMessage({ type: 'processResult', imageData: imgPixels }, [imgPixels.buffer]);
}
