type ReferenceCounts = { images: number; videos?: number; audios?: number };

const v1TokenPattern = /(?<![A-Za-z0-9._%+-])[@＠](?:参考图|图片|Image)(\d+)(?![\p{N}A-Za-z_]|\.[A-Za-z0-9_])/gu;
const v2TokenPattern = /(?<![A-Za-z0-9._%+-])[@＠](参考图|图片|Image|参考视频|视频|Video|参考音频|音频|Audio)(\d+)(?![\p{N}A-Za-z_]|\.[A-Za-z0-9_])/gu;

export function compileVideoV1Prompt(prompt: string, imageCount: number) {
    const text = prompt.replaceAll("＠", "@");
    const invalidTokens = new Set<string>();
    for (const match of text.matchAll(v1TokenPattern)) {
        const numberText = match[1];
        const number = Number(numberText);
        if (!Number.isSafeInteger(number) || number < 1 || number > imageCount || numberText !== String(number)) {
            invalidTokens.add(match[0]);
            continue;
        }
    }
    if (invalidTokens.size) throw new Error(`无效参考图引用：${Array.from(invalidTokens).join("、")}`);
    const body = text.replace(v1TokenPattern, (_, numberText: string) => `第${Number(numberText)}张参考图（REFERENCE_${Number(numberText) - 1}）`);
    if (!imageCount) return body;
    const mapping = Array.from({ length: imageCount }, (_, index) => `第${index + 1}张参考图对应 REFERENCE_${index}`).join("；");
    return `参考图严格按传入顺序编号：${mapping}。请严格按照这些编号理解下方指令，不要混淆不同参考图。\n\n${body}`;
}

export function normalizeVideoV2Prompt(prompt: string, counts: ReferenceCounts) {
    const text = prompt.replaceAll("＠", "@");
    const invalidTokens = new Set<string>();
    for (const match of text.matchAll(v2TokenPattern)) {
        const kind = normalizeReferenceKind(match[1]);
        const numberText = match[2];
        const number = Number(numberText);
        const max = kind === "Image" ? counts.images : kind === "Video" ? counts.videos || 0 : counts.audios || 0;
        if (!Number.isSafeInteger(number) || number < 1 || number > max || numberText !== String(number)) invalidTokens.add(match[0]);
    }
    if (invalidTokens.size) throw new Error(`无效参考资产引用：${Array.from(invalidTokens).join("、")}`);
    return text.replace(v2TokenPattern, (_, rawKind: string, numberText: string) => `@${normalizeReferenceKind(rawKind)}${Number(numberText)}`);
}

function normalizeReferenceKind(value: string) {
    if (value === "参考图" || value === "图片" || value === "Image") return "Image";
    if (value === "参考视频" || value === "视频" || value === "Video") return "Video";
    return "Audio";
}
