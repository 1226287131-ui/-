<?php
declare(strict_types=1);

const STORAGE_DIR = '/www/wwwroot/wxhb.kkone.vip-upload-data';
const PUBLIC_URL_PREFIX = 'https://wxhb.kkone.vip/api/uploads/files/';
const RETENTION_SECONDS = 3600;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    respond(405, ['error' => '仅支持 POST 上传']);
}

ensureStorage();
cleanupExpiredFiles();

$incoming = $_FILES['files'] ?? null;
if (!is_array($incoming) || !isset($incoming['name'])) {
    respond(400, ['error' => '请使用 files 字段上传文件']);
}

$names = normalizeField($incoming['name']);
$types = normalizeField($incoming['type'] ?? '');
$tmpNames = normalizeField($incoming['tmp_name'] ?? '');
$errors = normalizeField($incoming['error'] ?? UPLOAD_ERR_NO_FILE);
$sizes = normalizeField($incoming['size'] ?? 0);
if (count($names) === 0 || count($names) > MAX_FILES) {
    respond(400, ['error' => '一次最多上传 ' . MAX_FILES . ' 个文件']);
}

$stored = [];
foreach (array_keys($names) as $index) {
    $error = (int) ($errors[$index] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        removeStoredFiles($stored);
        respond(400, ['error' => uploadErrorMessage($error)]);
    }

    $tmpName = (string) ($tmpNames[$index] ?? '');
    $originalName = (string) ($names[$index] ?? 'reference.bin');
    $size = (int) ($sizes[$index] ?? 0);
    if (!$tmpName || !is_uploaded_file($tmpName)) {
        removeStoredFiles($stored);
        respond(400, ['error' => '上传文件无效']);
    }
    if ($size <= 0 || $size > MAX_FILE_BYTES) {
        removeStoredFiles($stored);
        respond(413, ['error' => '单个文件不能超过 64 MB']);
    }

    $clientMime = strtolower(trim(explode(';', (string) ($types[$index] ?? ''))[0]));
    $kind = classifyFile($originalName, $clientMime);
    if ($kind === null) {
        removeStoredFiles($stored);
        respond(415, ['error' => '只支持图片、视频或音频文件']);
    }

    try {
        $filename = bin2hex(random_bytes(18)) . '.' . $kind['extension'];
    } catch (Throwable $error) {
        removeStoredFiles($stored);
        respond(500, ['error' => '无法生成临时文件名']);
    }
    $target = STORAGE_DIR . DIRECTORY_SEPARATOR . $filename;
    if (!move_uploaded_file($tmpName, $target)) {
        removeStoredFiles($stored);
        respond(500, ['error' => '保存上传文件失败']);
    }

    $stored[] = $target;
    $storedFiles[] = [
        'url' => PUBLIC_URL_PREFIX . rawurlencode($filename),
        'kind' => $kind['kind'],
        'bytes' => $size,
        'mimeType' => $kind['mime'],
        'expiresAt' => gmdate('c', time() + RETENTION_SECONDS),
    ];
}

respond(200, ['files' => $storedFiles ?? []]);

function ensureStorage(): void
{
    if (!is_dir(STORAGE_DIR) && !@mkdir(STORAGE_DIR, 0770, true) && !is_dir(STORAGE_DIR)) {
        respond(500, ['error' => '上传目录不可用']);
    }
    if (!is_writable(STORAGE_DIR)) {
        respond(500, ['error' => '上传目录不可写']);
    }
}

function normalizeField(mixed $value): array
{
    return is_array($value) ? $value : [$value];
}

function cleanupExpiredFiles(): void
{
    $cutoff = time() - RETENTION_SECONDS;
    $entries = @scandir(STORAGE_DIR);
    if (!is_array($entries)) return;
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $path = STORAGE_DIR . DIRECTORY_SEPARATOR . $entry;
        if (is_file($path) && ((int) @filemtime($path)) < $cutoff) @unlink($path);
    }
}

function classifyFile(string $name, string $clientMime): ?array
{
    $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $map = [
        'jpg' => ['kind' => 'image', 'mime' => 'image/jpeg'],
        'jpeg' => ['kind' => 'image', 'mime' => 'image/jpeg'],
        'png' => ['kind' => 'image', 'mime' => 'image/png'],
        'webp' => ['kind' => 'image', 'mime' => 'image/webp'],
        'gif' => ['kind' => 'image', 'mime' => 'image/gif'],
        'mp4' => ['kind' => 'video', 'mime' => 'video/mp4'],
        'm4v' => ['kind' => 'video', 'mime' => 'video/x-m4v'],
        'mov' => ['kind' => 'video', 'mime' => 'video/quicktime'],
        'webm' => ['kind' => 'video', 'mime' => 'video/webm'],
        'mp3' => ['kind' => 'audio', 'mime' => 'audio/mpeg'],
        'wav' => ['kind' => 'audio', 'mime' => 'audio/wav'],
        'ogg' => ['kind' => 'audio', 'mime' => 'audio/ogg'],
        'oga' => ['kind' => 'audio', 'mime' => 'audio/ogg'],
        'm4a' => ['kind' => 'audio', 'mime' => 'audio/mp4'],
        'aac' => ['kind' => 'audio', 'mime' => 'audio/aac'],
        'flac' => ['kind' => 'audio', 'mime' => 'audio/flac'],
    ];
    if (!isset($map[$extension])) return null;
    $item = $map[$extension];
    if ($clientMime !== '' && !str_starts_with($clientMime, $item['kind'] . '/')) return null;
    return ['kind' => $item['kind'], 'mime' => $item['mime'], 'extension' => $extension];
}

function removeStoredFiles(array $paths): void
{
    foreach ($paths as $path) if (is_string($path)) @unlink($path);
}

function uploadErrorMessage(int $error): string
{
    return match ($error) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => '上传文件超过服务器限制',
        UPLOAD_ERR_PARTIAL => '上传文件未完成',
        UPLOAD_ERR_NO_FILE => '没有收到上传文件',
        default => '上传文件失败',
    };
}

function respond(int $status, array $payload): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
