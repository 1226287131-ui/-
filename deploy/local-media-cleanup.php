<?php
declare(strict_types=1);

const STORAGE_DIR = '/www/wwwroot/wxhb.kkone.vip-upload-data';
const RETENTION_SECONDS = 3600;

if (PHP_SAPI !== 'cli') exit(1);
$cutoff = time() - RETENTION_SECONDS;
$entries = @scandir(STORAGE_DIR);
if (!is_array($entries)) exit(0);
foreach ($entries as $entry) {
    if ($entry === '.' || $entry === '..') continue;
    $path = STORAGE_DIR . DIRECTORY_SEPARATOR . $entry;
    if (is_file($path) && ((int) @filemtime($path)) < $cutoff) @unlink($path);
}
