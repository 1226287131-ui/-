import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { ensureReferenceMentions, imageReferenceLabel } from "@/lib/image-reference-prompt";
import { dataUrlToFile } from "@/lib/image-utils";
import { getVideoModelProfile, inferMiniMaxH3WorkflowId, isMiniMaxH3ResolutionSize, isMiniMaxH3WorkflowId, normalizeMiniMaxH3AspectRatio, normalizeMiniMaxH3WorkflowSelection, normalizeMiniMaxH3WorkflowSize, normalizeVideoQualityForReferences, normalizeVideoQualityForModel, normalizeVideoRatioForModel, normalizeVideoSecondsForModel, normalizeVideoSizeForModel } from "@/lib/video-model";
import { compileVideoV1Prompt, normalizeVideoV2Prompt } from "@/lib/video-reference-prompt";
import { getMediaBlob, uploadMediaFile, type UploadedFile, type UploadMediaOptions } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { resolveReferenceMediaUrls } from "@/services/api/video-media";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceReferenceLabel, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = {
    id?: string;
    task_id?: string;
    status?: string;
    error?: { message?: string } | string;
    message?: string;
    url?: string;
    result_url?: string;
    video_url?: string;
    metadata?: { url?: string; [key: string]: unknown };
    content?: { video_url?: string; url?: string; [key: string]: unknown } | null;
    [key: string]: unknown;
};
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: unknown; msg?: string; message?: string; error?: { message?: string } | string; [key: string]: unknown };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

const VIDEO_QUERY_TIMEOUT_MS = 45_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

class NonVideoResponseError extends Error {
    readonly name = "NonVideoResponseError";
}

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; remoteOnly?: boolean };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "video-v1" | "video-v2" | "video-v2-full" | "video-v3" | "video-v3-qy" | "grok" | "minimax-h3" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();
const minimaxNotFoundAttempts = new Map<string, number>();
const MINIMAX_NOT_FOUND_RETRIES = 3;

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const delayMs =
        task.provider === "seedance" || task.provider === "video-v1" || task.provider === "video-v2" || task.provider === "video-v2-full" || task.provider === "video-v3" || task.provider === "video-v3-qy" || task.provider === "grok" || task.provider === "minimax-h3" ? 5000 : 2500;
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        await delay(delayMs, options?.signal);
    }
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const normalizedPrompt = normalizeVideoReferencePrompt(prompt, references, videoReferences, audioReferences);
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, normalizedPrompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    const profile = getVideoModelProfile(modelOptionName(selectedModel));
    if (profile.kind === "video-v1") return createVideoV1Task(requestConfig, selectedModel, normalizedPrompt, references, options);
    if (profile.kind === "video-v2-full") return createVideoV2FullTask(requestConfig, selectedModel, normalizedPrompt, references, videoReferences, audioReferences, options);
    if (profile.kind === "video-v2") return createVideoV2Task(requestConfig, selectedModel, normalizedPrompt, references, videoReferences, audioReferences, options);
    if (profile.kind === "video-v3") return createVideoV3Task(requestConfig, selectedModel, normalizedPrompt, references, videoReferences, audioReferences, options);
    if (profile.kind === "grok") return createGrokTask(requestConfig, selectedModel, normalizedPrompt, references, videoReferences, audioReferences, options);
    if (profile.kind === "minimax-h3") return createMiniMaxH3Task(requestConfig, selectedModel, normalizedPrompt, references, videoReferences, audioReferences, options);
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, normalizedPrompt, references, videoReferences, audioReferences, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error(apiText("videoReferencesUnsupported"));
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, normalizedPrompt, references, options);
}

function normalizeVideoReferencePrompt(prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    return ensureReferenceMentions(
        prompt,
        [
            ...references.map((_, index) => imageReferenceLabel(index)),
            ...videoReferences.map((_, index) => seedanceReferenceLabel("video", index)),
            ...audioReferences.map((_, index) => seedanceReferenceLabel("audio", index)),
        ],
    );
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "video-v1") return pollVideoV1Task(requestConfig, task, options);
    if (task.provider === "video-v2") return pollVideoV2Task(requestConfig, task, options);
    if (task.provider === "video-v2-full") return pollVideoV2FullTask(requestConfig, task, options);
    if (task.provider === "video-v3") return pollVideoV3Task(requestConfig, task, options);
    if (task.provider === "video-v3-qy") return pollVideoV3QyTask(requestConfig, task, options);
    if (task.provider === "grok") return pollGrokTask(requestConfig, task, options);
    if (task.provider === "minimax-h3") return pollMiniMaxH3Task(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const profile = getVideoModelProfile(modelOptionName(model));
    const requestConfig = {
        ...config,
        vquality: normalizeVideoQualityForReferences(model, config.vquality, references.length),
        ...(profile.kind === "minimax-h3" ? { videoSeconds: normalizeVideoSecondsForModel(model, config.videoSeconds), size: normalizeVideoSizeForModel(model, config.size) } : {}),
    };
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config: requestConfig,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(requestConfig.videoSeconds),
                size: normalizeVideoSize(requestConfig.size),
                resolution: normalizeVideoResolution(requestConfig.vquality),
                ratio: requestConfig.size,
                generateAudio: boolConfig(requestConfig.videoGenerateAudio, true),
                watermark: boolConfig(requestConfig.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult, options?: UploadMediaOptions): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video", options);
    if (result.url) {
        if (result.remoteOnly) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        if (options?.deferPersistence) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createVideoV1Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const media = await resolveReferenceMediaUrls(references, [], []);
    const payload: Record<string, unknown> = {
        model: modelOptionName(model),
        prompt: compileVideoV1Prompt(prompt, references.length),
        duration: Number(normalizeVideoSecondsForModel(model, config.videoSeconds)),
        aspect_ratio: normalizeVideoRatioForModel(model, config.size),
    };
    if (media.images.length) payload.images = media.images;
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/video/generations"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "video-v1", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createVideoV2Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const media = await resolveReferenceMediaUrls(references, videoReferences, audioReferences);
    const payload = {
        model: modelOptionName(model),
        prompt: normalizeVideoV2Prompt(prompt, { images: media.images.length, videos: media.videos.length, audios: media.audios.length }),
        images: media.images,
        videos: media.videos,
        audios: media.audios,
        aspect_ratio: normalizeVideoRatioForModel(model, config.size),
        duration: Number(normalizeVideoSecondsForModel(model, config.videoSeconds)),
        resolution: normalizeVideoQualityForModel(model, config.vquality),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
    };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "video-v2", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createVideoV2FullTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const profile = getVideoModelProfile(modelName);
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    if (Array.from(prompt).length > 4000) throw new Error("video-v2-满血兜底版提示词不能超过 4000 个字符");
    const media = await resolveReferenceMediaUrls(references.slice(0, profile.maxImages), videoReferences.slice(0, profile.maxVideos), audioReferences.slice(0, profile.maxAudios));
    const payload = {
        model: modelName,
        prompt: normalizeVideoV2Prompt(prompt, { images: media.images.length, videos: media.videos.length, audios: media.audios.length }),
        images: media.images,
        videos: media.videos,
        audios: media.audios,
        aspect_ratio: normalizeVideoRatioForModel(modelName, config.size),
        duration: Number(normalizeVideoSecondsForModel(modelName, config.videoSeconds)),
    };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "video-v2-full", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createVideoV3Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const profile = getVideoModelProfile(modelName);
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    if (uniqueReferenceCount(references) > profile.maxImages) throw new Error(`video-v3 最多支持 ${profile.maxImages} 张参考图`);
    if (uniqueReferenceCount(videoReferences) > profile.maxVideos) throw new Error(`video-v3 最多支持 ${profile.maxVideos} 个参考视频`);
    if (uniqueReferenceCount(audioReferences) > profile.maxAudios) throw new Error(`video-v3 最多支持 ${profile.maxAudios} 个参考音频`);
    const media = await resolveReferenceMediaUrls(references, videoReferences, audioReferences);
    const images = uniqueMediaUrls(media.images);
    const videos = uniqueMediaUrls(media.videos);
    const audios = uniqueMediaUrls(media.audios);
    if (images.length > profile.maxImages) throw new Error(`video-v3 最多支持 ${profile.maxImages} 张参考图`);
    if (videos.length > profile.maxVideos) throw new Error(`video-v3 最多支持 ${profile.maxVideos} 个参考视频`);
    if (audios.length > profile.maxAudios) throw new Error(`video-v3 最多支持 ${profile.maxAudios} 个参考音频`);
    const duration = Number(normalizeVideoSecondsForModel(modelName, config.videoSeconds));
    // The QY contract accepts up to 29 seconds. Retain the established V3 request at 30 seconds.
    if (duration <= 29) {
        const payload: Record<string, unknown> = {
            model: modelName,
            prompt: prompt.trim(),
            duration,
            aspect_ratio: normalizeVideoRatioForModel(modelName, config.size),
            resolution: normalizeVideoQualityForModel(modelName, config.vquality),
            audio: boolConfig(config.videoGenerateAudio, true),
        };
        if (images.length) payload.images = images;
        if (videos.length) payload.videos = videos;
        if (audios.length) payload.audios = audios;
        try {
            const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos/generations"), payload, { headers: { ...aiHeaders(config, "application/json"), Accept: "application/json" }, signal: options?.signal })).data);
            const id = taskIdOf(created);
            if (!id) throw new Error(apiText("noVideoTaskId"));
            return { id, provider: "video-v3-qy", model };
        } catch (error) {
            throwIfRequestAborted(error, options?.signal);
            throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
        }
    }
    const payload: Record<string, unknown> = {
        model: modelName,
        prompt: prompt.trim(),
        duration,
        ratio: normalizeVideoRatioForModel(modelName, config.size),
        resolution: "720p",
        generate_audio: boolConfig(config.videoGenerateAudio, true),
    };
    if (images.length) payload.images = images;
    if (videos.length) payload.videos = videos;
    if (audios.length) payload.audios = audios;
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: { ...aiHeaders(config, "application/json"), Accept: "application/json" }, signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "video-v3", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createMiniMaxH3Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const profile = getVideoModelProfile(modelName);
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    if (references.length > profile.maxImages) throw new Error(`MiniMax-H3 最多支持 ${profile.maxImages} 张参考图`);
    if (videoReferences.length > profile.maxVideos) throw new Error(`MiniMax-H3 最多支持 ${profile.maxVideos} 个参考视频`);
    if (audioReferences.length > profile.maxAudios) throw new Error(`MiniMax-H3 最多支持 ${profile.maxAudios} 个独立参考音频`);
    const media = await resolveReferenceMediaUrls(references, videoReferences, audioReferences);
    const images = uniqueMiniMaxMediaUrls(media.images);
    const videos = uniqueMiniMaxMediaUrls(media.videos);
    const audios = uniqueMiniMaxMediaUrls(media.audios);
    const workflowSelection = normalizeMiniMaxH3WorkflowSelection(config.videoWorkflow);
    const workflowId = workflowSelection === "auto"
        ? inferMiniMaxH3WorkflowId({ images: images.length, videos: videos.length, audios: audios.length })
        : workflowSelection;
    if (!isMiniMaxH3WorkflowId(workflowId)) throw new Error("MiniMax-H3 的 workflow_id 无效");
    if (workflowId === "text-to-video" && (images.length || videos.length || audios.length)) {
        throw new Error("MiniMax-H3 的 text-to-video 工作流不能携带参考素材");
    }
    if (workflowId === "multi-reference" || workflowId === "cf-multi-reference") {
        if (!images.length) throw new Error(`MiniMax-H3 的 ${workflowId} 工作流至少需要 1 张参考图`);
    }
    if (workflowId === "fl2v" || workflowId === "cf-fl2v") {
        if (images.length < 1 || images.length > 2) throw new Error(`MiniMax-H3 的 ${workflowId} 工作流需要 1-2 张参考图`);
        if (videos.length || audios.length) throw new Error(`MiniMax-H3 的 ${workflowId} 工作流不能同时使用参考视频或参考音频`);
    }
    const workflowSize = workflowId.startsWith("cf-") ? normalizeMiniMaxH3WorkflowSize(config.videoWorkflowSize) : undefined;
    const size = workflowSize || normalizeVideoSizeForModel(modelName, config.size);
    const payload: Record<string, unknown> = {
        model: modelName,
        prompt: prompt.trim(),
        workflow_id: workflowId,
        seconds: Number(normalizeVideoSecondsForModel(modelName, config.videoSeconds)),
        size,
    };
    if (isMiniMaxH3ResolutionSize(size)) payload.aspect_ratio = normalizeMiniMaxH3AspectRatio(config.videoAspectRatio);
    if (images.length) payload.images = images.slice(0, profile.maxImages);
    if (videos.length) payload.reference_videos = videos.slice(0, profile.maxVideos);
    if (audios.length) payload.reference_audios = audios.slice(0, profile.maxAudios);
    try {
        const created = unwrapVideoResponse(
            (await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: { ...aiHeaders(config, "application/json"), Accept: "application/json" }, signal: options?.signal })).data,
        );
        const id = taskIdOf(created);
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "minimax-h3", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createGrokTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    if (videoReferences.length) throw new Error("Grok 不支持参考视频");
    if (audioReferences.length) throw new Error("Grok 不支持参考音频");
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSecondsForModel(model, config.videoSeconds));
    body.append("aspect_ratio", normalizeVideoRatioForModel(model, config.size));
    body.append("resolution", normalizeVideoQualityForReferences(model, config.vquality, references.length));
    for (const reference of references) {
        const file = dataUrlToFile({ ...reference, dataUrl: await imageToDataUrl(reference) });
        if (!file.size) throw new Error("Grok 参考图不能为空");
        if (!file.type.toLowerCase().startsWith("image/")) throw new Error("Grok 仅支持图片格式的参考图");
        body.append("input_reference", file);
    }
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "grok", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const video = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(video.error) || readApiErrorMessage(video.message) || apiText("videoGenerationFailed") };
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
        if (isSuccessStatus(status)) return downloadVideoContentWhenReady(config, `/videos/${encodeURIComponent(task.id)}/content`, options);
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function pollVideoV1Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/video/generations/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || "video-v1 视频生成失败" };
        const url = videoResultUrl(payload, config.baseUrl);
        // 中转站可能先写入成片 URL，之后才更新任务状态，因此 URL 优先。
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
        // 成功状态不代表成片 URL 已发布；继续轮询直到真正返回视频或明确失败。
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "video-v1 任务查询失败"));
    }
}

async function pollVideoV2Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    return pollOpenCompatibleTask(config, task, options, "video-v2");
}

async function pollVideoV2FullTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    return pollOpenCompatibleTask(config, task, options, "video-v2-满血兜底版");
}

async function pollVideoV3Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || "video-v3 视频生成失败" };
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) {
            try {
                return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
            } catch (error) {
                throwIfRequestAborted(error, options?.signal);
                if (isVideoV3NotFound(error) || isRetryableVideoPollError(error)) return { status: "pending" };
                throw error;
            }
        }
        // video-v3 会在成片落盘前先返回 completed，不能因此结束任务。
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "video-v3 任务查询失败"));
    }
}

function uniqueMediaUrls(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueReferenceCount(references: Array<{ id: string; url?: string; dataUrl?: string; storageKey?: string }>) {
    return new Set(references.map((reference) => reference.url || reference.dataUrl || reference.storageKey || reference.id)).size;
}

async function pollGrokTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || "Grok 视频生成失败" };
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
        if (isSuccessStatus(status)) return downloadVideoContentWhenReady(config, `/videos/${encodeURIComponent(task.id)}/content`, options);
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "Grok 任务查询失败"));
    }
}

async function pollMiniMaxH3Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        minimaxNotFoundAttempts.delete(task.id);
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) {
            minimaxNotFoundAttempts.delete(task.id);
            return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || "MiniMax-H3 视频生成失败" };
        }
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) {
            minimaxNotFoundAttempts.delete(task.id);
            return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
        }
        if (isSuccessStatus(status)) return downloadVideoContentWhenReady(config, `/videos/${encodeURIComponent(task.id)}/content`, options);
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (shouldRetryMiniMaxNotFound(error, task.id) || isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "MiniMax-H3 任务查询失败"));
    }
}

async function pollVideoV3QyTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/generations/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || "video-v3 视频生成失败" };
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "video-v3 任务查询失败"));
    }
}

function uniqueMiniMaxMediaUrls(urls: string[]) {
    const seenUrls = new Set<string>();
    const seenFileNames = new Set<string>();
    return urls.filter((rawUrl) => {
        const url = rawUrl.trim();
        if (!url) return false;
        const fileName = decodeURIComponent(url.split(/[?#]/, 1)[0].split("/").pop() || "").toLowerCase();
        if (seenUrls.has(url) || (fileName && seenFileNames.has(fileName))) return false;
        seenUrls.add(url);
        if (fileName) seenFileNames.add(fileName);
        return true;
    });
}

async function pollOpenCompatibleTask(config: AiConfig, task: VideoGenerationTask, options: RequestOptions | undefined, label: string): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || `${label} 视频生成失败` };
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
        if (isSuccessStatus(status)) return downloadVideoContentWhenReady(config, `/videos/${encodeURIComponent(task.id)}/content`, options);
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, `${label} 任务查询失败`));
    }
}

async function downloadVideoContentWhenReady(config: AiConfig, path: string, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        return { status: "completed", result: await downloadVideoContent(config, path, options) };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        // 有些中转站先更新 completed，再异步把视频放到内容接口；这时继续轮询。
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw error;
    }
}

async function downloadVideoContent(config: AiConfig, path: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    const response = await axios.get<Blob>(aiApiUrl(config, path), {
        headers: aiHeaders(config),
        responseType: "blob",
        timeout: VIDEO_DOWNLOAD_TIMEOUT_MS,
        signal: options?.signal,
    });
    await assertVideoBlob(response.data);
    return { blob: response.data, mimeType: response.data.type || "video/mp4" };
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error(apiText("seedanceAudioRequiresVisual"));
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error(apiText("videoPromptRequired"));
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("seedanceNoTaskId"));
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, apiText("seedanceTaskCreateFailed")));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapSeedanceTask(payload);
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options, true) };
        // 接口会在 URL 仍未发布时提前返回 succeeded；保持等待直到明确失败或回传视频。
        if (state.status === "succeeded" || state.status === "completed") return { status: "pending" };
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired")
            return { status: "failed", error: readApiErrorMessage(state.error?.message) || apiText(state.status === "expired" ? "seedanceVideoTimeout" : "seedanceVideoFailed") };
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, apiText("seedanceTaskQueryFailed")));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error(apiText("seedanceVideoDuration"));
        total += video.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceVideoTotalDuration"));
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error(apiText("seedanceAudioDuration"));
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceAudioTotalDuration"));
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("referenceImageReadFailed"));
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceVideo"));
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceAudio"));
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(config: AiConfig, url: string, options?: RequestOptions, retryNotFound = false): Promise<VideoGenerationResult> {
    if (isPublicMediaUrl(url) && !sameOriginAsBaseUrl(url, config.baseUrl)) {
        // 跨域 CDN 可能禁止 HEAD 或不支持浏览器读取响应；直接交给 video 元素加载，避免下载整段大文件阻塞画布。
        return { url, mimeType: "video/mp4", remoteOnly: true };
    }
    try {
        const response = await axios.get<Blob>(url, { headers: videoResultHeaders(config, url), responseType: "blob", timeout: VIDEO_DOWNLOAD_TIMEOUT_MS, signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data, mimeType: response.data.type || "video/mp4" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (retryNotFound && (isVideoV3NotFound(error) || isRetryableVideoPollError(error))) throw error;
        if (error instanceof NonVideoResponseError) throw error;
        return { url, mimeType: "video/mp4", remoteOnly: true };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse): VideoResponse {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>): SeedanceTask {
    return unwrapEnvelope(payload, apiText("seedanceNoTask"));
}

function unwrapEnvelope<T>(payload: unknown, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    let current: unknown = payload;
    for (let depth = 0; depth < 6; depth += 1) {
        if (!current || typeof current !== "object") break;
        const record = current as Record<string, unknown>;
        if ("code" in record && record.code !== undefined) {
            if (!isSuccessfulEnvelopeCode(record.code)) throw new Error(readApiErrorMessage(record) || apiText("requestFailed"));
            if ("data" in record && record.data) {
                current = record.data;
                continue;
            }
            if (hasVideoTaskFields(record)) break;
            throw new Error(emptyMessage);
        }
        if ("data" in record && record.data && !hasVideoTaskFields(record)) {
            current = record.data;
            continue;
        }
        break;
    }
    if (!current || typeof current !== "object") throw new Error(emptyMessage);
    return current as T;
}

function isSuccessfulEnvelopeCode(code: unknown) {
    if (code === 0 || code === "0") return true;
    if (typeof code === "number") return code >= 200 && code < 300;
    if (typeof code === "string" && /^2\d\d$/.test(code.trim())) return true;
    return typeof code === "string" && ["ok", "success", "succeeded"].includes(code.trim().toLowerCase());
}

function videoResultUrl(payload: unknown, baseUrl = "") {
    const preferredKeys = ["result_url", "video_url", "download_url", "file_url"];
    const visit = (value: unknown, depth: number, includeGenericUrl: boolean): string | undefined => {
        if (!value || typeof value !== "object" || depth > 8) return undefined;
        const record = value as Record<string, unknown>;
        for (const key of preferredKeys) {
            const candidate = resolveVideoUrl(record[key], baseUrl);
            if (candidate) return candidate;
        }
        if (includeGenericUrl) {
            const candidate = resolveVideoUrl(record.url, baseUrl);
            if (candidate) return candidate;
        }
        for (const key of ["metadata", "task", "state", "content", "result", "data", "output", "response", "video", "file", "media"]) {
            const nested = record[key];
            if (Array.isArray(nested)) {
                for (const item of nested) {
                    const candidate = visit(item, depth + 1, includeGenericUrl);
                    if (candidate) return candidate;
                }
            } else {
                const candidate = visit(nested, depth + 1, includeGenericUrl);
                if (candidate) return candidate;
            }
        }
        return undefined;
    };
    return visit(payload, 0, false) || visit(payload, 0, true);
}

function videoStatus(payload: unknown) {
    const statuses: string[] = [];
    const visit = (value: unknown, depth: number) => {
        if (!value || typeof value !== "object" || depth > 8) return;
        const record = value as Record<string, unknown>;
        for (const key of ["status", "state", "task_status"]) {
            if (typeof record[key] === "string") statuses.push(record[key].toLowerCase().trim());
        }
        for (const key of ["metadata", "task", "state", "data", "result", "output", "response", "content", "video", "file", "media"]) {
            const nested = record[key];
            if (Array.isArray(nested)) nested.forEach((item) => visit(item, depth + 1));
            else visit(nested, depth + 1);
        }
    };
    visit(payload, 0);
    return statuses.find(isFailureStatus) || statuses.find(isSuccessStatus) || statuses[0] || "";
}

function isSuccessStatus(status: string) {
    return ["success", "succeeded", "completed", "complete", "done", "finished", "ready"].includes(status.replace(/[\s-]/g, "_"));
}

function isFailureStatus(status: string) {
    return ["failed", "failure", "cancelled", "canceled", "expired", "error"].includes(status.replace(/[\s-]/g, "_"));
}

function hasVideoTaskFields(value: Record<string, unknown>) {
    return ["id", "task_id", "status", "result_url", "video_url", "download_url", "file_url", "url", "content", "error"].some((key) => key in value);
}

function resolveVideoUrl(value: unknown, baseUrl: string) {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const raw = value.trim();
    if (!isPublicMediaUrl(raw) && !/^(?:\/?[^\s]+\.mp4(?:\?|#|$)|\/(?:api|v1|videos?)\b|\.\.?(?:\/|$))/i.test(raw)) return undefined;
    if (isPublicMediaUrl(raw)) return raw;
    try {
        const fallbackOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
        const base = new URL(baseUrl, fallbackOrigin);
        return new URL(raw, raw.startsWith("/") ? base : `${base.origin}/`).toString();
    } catch {
        return raw;
    }
}

function videoResultHeaders(config: AiConfig, url: string) {
    return sameOriginAsBaseUrl(url, config.baseUrl) ? aiHeaders(config) : undefined;
}

function sameOriginAsBaseUrl(url: string, baseUrl: string) {
    try {
        const fallbackOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
        return new URL(url, new URL(baseUrl, fallbackOrigin)).origin === new URL(baseUrl, fallbackOrigin).origin;
    } catch {
        return false;
    }
}

function taskIdOf(payload: unknown) {
    const visit = (value: unknown, depth: number): string => {
        if (!value || depth > 8) return "";
        if (Array.isArray(value)) {
            for (const item of value) {
                const id = visit(item, depth + 1);
                if (id) return id;
            }
            return "";
        }
        if (typeof value !== "object") return "";
        const record = value as Record<string, unknown>;
        for (const key of ["task_id", "id"]) {
            const candidate = record[key];
            if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) return String(candidate);
        }
        for (const key of ["data", "task", "result", "response", "output", "state", "metadata", "content"]) {
            const id = visit(record[key], depth + 1);
            if (id) return id;
        }
        return "";
    };
    return visit(payload, 0);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && parsed && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg = typeof payload.error === "string" ? payload.error : (payload.error as { message?: unknown })?.message;
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(errorMsg) || readApiErrorMessage(payload.detail) || "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

function isRetryableVideoPollError(error: unknown) {
    if (error instanceof NonVideoResponseError) return true;
    if (!axios.isAxiosError(error)) return false;
    if (["ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK"].includes(error.code || "")) return true;
    const status = error.response?.status;
    return !status || status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function isVideoV3NotFound(error: unknown) {
    return axios.isAxiosError(error) && error.response?.status === 404;
}

function shouldRetryMiniMaxNotFound(error: unknown, taskId: string) {
    if (!axios.isAxiosError(error) || error.response?.status !== 404) return false;
    const attempts = (minimaxNotFoundAttempts.get(taskId) || 0) + 1;
    if (attempts <= MINIMAX_NOT_FOUND_RETRIES) {
        minimaxNotFoundAttempts.set(taskId, attempts);
        return true;
    }
    minimaxNotFoundAttempts.delete(taskId);
    return false;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.size) throw new NonVideoResponseError(apiText("videoDownloadFailed"));
    const mime = (blob.type || "").toLowerCase();
    const declaredText = mime.includes("json") || mime.includes("html") || mime.startsWith("text/");
    const inspectUnknownMime = !mime || mime === "application/octet-stream";
    const sample = declaredText || inspectUnknownMime ? (await blob.slice(0, 4096).text()).trimStart() : "";
    const looksLikeJson = sample.startsWith("{") || sample.startsWith("[");
    const looksLikeHtml = /^<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(sample);
    if (!declaredText && !looksLikeJson && !looksLikeHtml) return;
    let payload: unknown;
    if (looksLikeJson || mime.includes("json")) {
        try {
            payload = JSON.parse(await blob.text());
        } catch {
            // 保持通用的非视频响应错误。
        }
    }
    throw new NonVideoResponseError(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
}

function isRequestAborted(error: unknown, signal?: AbortSignal) {
    return axios.isCancel(error) || Boolean(signal?.aborted) || (error instanceof DOMException && error.name === "AbortError");
}

function throwIfRequestAborted(error: unknown, signal?: AbortSignal) {
    if (!isRequestAborted(error, signal)) return;
    if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new DOMException("Aborted", "AbortError");
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(apiText("localAssetReadFailed")));
        reader.readAsDataURL(blob);
    });
}
