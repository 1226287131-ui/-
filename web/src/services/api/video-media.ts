import axios from "axios";

import { MEDIA_UPLOAD_URL } from "@/constant/runtime-config";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type MediaKind = "image" | "video" | "audio";
type MediaReference = { id: string; kind: MediaKind; name: string; url?: string; storageKey?: string; dataUrl?: string };
type UploadedRemoteFile = { url?: string; kind?: string };

export async function resolveReferenceMediaUrls(images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const references: MediaReference[] = [
        ...images.map((item) => ({ id: item.id, kind: "image" as const, name: item.name, url: item.url, dataUrl: item.dataUrl, storageKey: item.storageKey })),
        ...videos.map((item) => ({ id: item.id, kind: "video" as const, name: item.name, url: item.url, storageKey: item.storageKey })),
        ...audios.map((item) => ({ id: item.id, kind: "audio" as const, name: item.name, url: item.url, storageKey: item.storageKey })),
    ];
    const resolved = await Promise.all(references.map(resolveReference));
    const uploadItems = resolved.filter((item): item is { reference: MediaReference; blob: Blob } => Boolean(item.blob));
    const uploaded = uploadItems.length ? await uploadRemoteMedia(uploadItems) : [];
    let uploadIndex = 0;
    const urls = new Map<MediaReference, string>();
    for (const item of resolved) {
        if (item.url) urls.set(item.reference, item.url);
        else {
            const value = uploaded[uploadIndex++];
            if (!value) throw new Error(`${mediaKindLabel(item.reference.kind)}上传失败，接口没有返回公网 URL`);
            urls.set(item.reference, value);
        }
    }
    return {
        images: images.map((item) => requireResolvedUrl(urls, references.find((ref) => ref.id === item.id), "参考图")),
        videos: videos.map((item) => requireResolvedUrl(urls, references.find((ref) => ref.id === item.id), "参考视频")),
        audios: audios.map((item) => requireResolvedUrl(urls, references.find((ref) => ref.id === item.id), "参考音频")),
    };
}

async function resolveReference(reference: MediaReference) {
    if (isPublicUrl(reference.url)) return { reference, url: reference.url };
    let blob: Blob | null = null;
    if (reference.kind === "image") {
        if (reference.storageKey) blob = await getImageBlob(reference.storageKey);
        if (!blob && reference.dataUrl) blob = await (await fetch(reference.dataUrl)).blob();
        if (!blob && reference.url) blob = await (await fetch(reference.url)).blob();
    } else {
        if (reference.storageKey) blob = await getMediaBlob(reference.storageKey);
        if (!blob && reference.url) blob = await (await fetch(reference.url)).blob();
    }
    if (!blob) throw new Error(`${mediaKindLabel(reference.kind)}读取失败，请重新上传`);
    return { reference, blob };
}

async function uploadRemoteMedia(items: Array<{ reference: MediaReference; blob: Blob }>) {
    const form = new FormData();
    for (const item of items) form.append("files[]", item.blob, item.reference.name || `reference-${Date.now()}`);
    try {
        const response = await axios.post<{ files?: UploadedRemoteFile[]; error?: string }>(MEDIA_UPLOAD_URL, form, { timeout: 180000 });
        const files = Array.isArray(response.data?.files) ? response.data.files : [];
        if (files.length !== items.length) throw new Error(response.data?.error || "上传接口返回的文件数量不一致");
        const queues = new Map<MediaKind, string[]>();
        for (const file of files) {
            const kind = file.kind as MediaKind;
            if (!file.url || !["image", "video", "audio"].includes(kind)) throw new Error("上传接口返回了无效的媒体 URL");
            const queue = queues.get(kind) || [];
            queue.push(file.url);
            queues.set(kind, queue);
        }
        return items.map((item) => queues.get(item.reference.kind)?.shift() || "");
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const message = typeof error.response?.data?.error === "string" ? error.response.data.error : "参考素材上传失败";
            throw new Error(`${message}（${error.response?.status || "网络错误"}）`);
        }
        throw error instanceof Error ? error : new Error("参考素材上传失败");
    }
}

function requireResolvedUrl(urls: Map<MediaReference, string>, reference: MediaReference | undefined, label: string) {
    const url = reference ? urls.get(reference) : "";
    if (!url) throw new Error(`${label}上传失败，接口没有返回公网 URL`);
    return url;
}

function isPublicUrl(value?: string): value is string {
    return Boolean(value && /^https?:\/\//i.test(value));
}

function mediaKindLabel(kind: MediaKind) {
    return kind === "image" ? "参考图" : kind === "video" ? "参考视频" : "参考音频";
}
