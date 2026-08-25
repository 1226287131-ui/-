import localforage from "localforage";
import { nanoid } from "nanoid";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };
export type UploadMediaOptions = { deferPersistence?: boolean; deferMetadata?: boolean };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();
const MEDIA_FETCH_TIMEOUT_MS = 120_000;
const MEDIA_METADATA_TIMEOUT_MS = 15_000;
const MEDIA_STORAGE_TIMEOUT_MS = 30_000;

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: UploadMediaOptions): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetchWithTimeout(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    let persisted = false;
    const persist = async () => {
        try {
            await withTimeout(store.setItem(storageKey, blob), MEDIA_STORAGE_TIMEOUT_MS);
            return true;
        } catch {
            // IndexedDB failure must not block the current canvas result; keep the object URL usable for this session.
            return false;
        }
    };
    if (options?.deferPersistence) {
        objectUrls.set(storageKey, url);
        void persist();
    } else {
        persisted = await persist();
        if (persisted) objectUrls.set(storageKey, url);
    }
    const mimeType = blob.type || (prefix.startsWith("video") ? "video/mp4" : prefix.startsWith("audio") ? "audio/mpeg" : "application/octet-stream");
    const meta = options?.deferMetadata ? {} : mimeType.startsWith("video/") ? await readVideoMeta(url) : mimeType.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey: options?.deferPersistence || persisted ? storageKey : "", bytes: blob.size, mimeType, ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            video.onloadedmetadata = null;
            video.onerror = null;
            resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        };
        const timer = window.setTimeout(done, MEDIA_METADATA_TIMEOUT_MS);
        video.onloadedmetadata = done;
        video.onerror = done;
        video.preload = "metadata";
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            audio.onloadedmetadata = null;
            audio.onerror = null;
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        const timer = window.setTimeout(done, MEDIA_METADATA_TIMEOUT_MS);
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.preload = "metadata";
        audio.src = url;
    });
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(input, { ...init, signal: init?.signal || controller.signal });
        if (!response.ok) throw new Error(`媒体下载失败（${response.status}）`);
        return response;
    } finally {
        window.clearTimeout(timer);
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    let timer: number | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = window.setTimeout(() => reject(new Error("媒体本地保存超时")), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
    }
}
