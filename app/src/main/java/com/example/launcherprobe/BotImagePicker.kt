package com.example.launcherprobe

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * 系统图片选择/拍照：Activity result → 解码 → EXIF 纠偏 → 限尺寸/限字节重编码 → base64。
 *
 * 拍照经 ACTION_IMAGE_CAPTURE + 私有 cacheDir/image_picker FileProvider 输出，完成/取消/销毁
 * 一律删除临时文件；图库经 ACTION_OPEN_DOCUMENT（退化为 GET_CONTENT），都只授权本次读取。
 * 不申请相机或媒体权限：相机应用与系统选择器自身承载权限，读取使用临时 URI 授权。
 * 同时只允许一个会话（并发 RPC_BUSY）；Activity 销毁时待完成会话以 CANCELLED 收尾。
 * 解码与重编码在后台线程，回调统一回到主线程。
 */
internal class BotImagePicker(private val activity: Activity) {

    internal sealed class Outcome {
        class Images(val images: JSONArray) : Outcome()
        object Cancelled : Outcome()
        class Failed(val code: String, val message: String) : Outcome()
    }

    internal class PickerException(val code: String, message: String) : Exception(message)

    private class Session(val source: String, val done: (Outcome) -> Unit)

    private val main = Handler(Looper.getMainLooper())
    private var session: Session? = null
    private var cameraFile: File? = null
    private var cameraUri: Uri? = null

    /** 同步构建 Intent 并占位会话；构建失败抛 PickerException（会话不留置）。 */
    @Throws(PickerException::class)
    fun begin(source: String, done: (Outcome) -> Unit): Intent {
        if (session != null) throw PickerException("RPC_BUSY", "已有图片选择正在进行")
        if (activity.isFinishing || activity.isDestroyed) throw PickerException("CANCELLED", "界面已结束")
        val intent = when (source) {
            SOURCE_CAMERA -> cameraIntent()
            else -> photosIntent() ?: throw PickerException("NOT_AVAILABLE", "没有可用的图片选择器")
        }
        session = Session(source, done)
        return intent
    }

    /** 启动 Activity 失败时调用方清理：不触发回调（调用方自行回复 Invoke）。 */
    fun abort() {
        session = null
        cleanupCamera()
    }

    /** Activity 销毁：待完成会话以 CANCELLED 收尾并清理临时文件。 */
    fun destroy() {
        finish(Outcome.Failed("CANCELLED", "界面已结束"))
    }

    /** ActivityResult 分发入口（主线程）。 */
    fun deliver(result: ActivityResult) {
        val session = session ?: return
        if (result.resultCode != Activity.RESULT_OK) {
            finish(Outcome.Cancelled)
            return
        }
        val uris = if (session.source == SOURCE_CAMERA) {
            cameraUri?.let { listOf(it) } ?: emptyList()
        } else {
            collectUris(result.data)
        }
        if (uris.isEmpty()) {
            finish(Outcome.Cancelled)
            return
        }
        if (uris.size > MAX_IMAGES) {
            finish(Outcome.Failed("TOO_MANY", "一次最多选择 16 张图片"))
            return
        }
        process(session, uris)
    }

    private fun finish(outcome: Outcome) {
        val session = session ?: return
        this.session = null
        cleanupCamera()
        session.done(outcome)
    }

    private fun cleanupCamera() {
        val uri = cameraUri
        cameraUri = null
        if (uri != null) {
            try {
                // 撤销 begin 时按包名授予的全部读写授权，再删临时文件。
                activity.revokeUriPermission(uri,
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (t: Throwable) { /* 授权回收尽力而为 */ }
        }
        cameraFile?.let { try { it.delete() } catch (t: Throwable) { /* 临时文件尽力清理 */ } }
        cameraFile = null
    }

    private fun collectUris(data: Intent?): List<Uri> {
        if (data == null) return emptyList()
        val uris = LinkedHashSet<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index)?.uri?.let(uris::add)
            }
        }
        data.data?.let(uris::add)
        return uris.toList()
    }

    // ---------- Intent 构建 ----------

    private fun photosIntent(): Intent? {
        val open = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            putExtra(Intent.EXTRA_LOCAL_ONLY, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        if (canHandle(open)) return open
        val get = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            putExtra(Intent.EXTRA_LOCAL_ONLY, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return if (canHandle(get)) get else null
    }

    private fun cameraIntent(): Intent {
        val dir = File(activity.cacheDir, "image_picker")
        if (!dir.isDirectory && !dir.mkdirs()) {
            throw PickerException("INTERNAL", "无法准备相机输出目录")
        }
        val file = File(dir, "capture_${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".imagepicker", file)
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val resolved = activity.packageManager
            .queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
        if (resolved.isEmpty()) {
            file.delete()
            throw PickerException("NOT_AVAILABLE", "没有可用的相机应用")
        }
        // 目标相机应用不确定：逐一向可处理的包授予写权限。
        for (info in resolved) {
            activity.grantUriPermission(
                info.activityInfo.packageName, uri,
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        }
        cameraFile = file
        cameraUri = uri
        return intent
    }

    private fun canHandle(intent: Intent): Boolean =
        activity.packageManager
            .queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
            .isNotEmpty()

    // ---------- 解码与编码（后台线程） ----------

    private fun process(session: Session, uris: List<Uri>) {
        Thread {
            val images = JSONArray()
            var failure: PickerException? = null
            var totalBytes = 0L
            for (uri in uris) {
                try {
                    val image = decode(uri)
                    totalBytes += image.getLong("size")
                    if (totalBytes > MAX_TOTAL_BYTES) {
                        throw PickerException("TOO_LARGE", "图片总大小超过 64MB")
                    }
                    images.put(image)
                } catch (e: PickerException) {
                    failure = e
                    break
                } catch (t: Throwable) {
                    failure = PickerException("DECODE_FAILED", "无法处理所选图片")
                    break
                }
            }
            val outcome = if (failure != null) {
                Outcome.Failed(failure!!.code, failure!!.message ?: "图片处理失败")
            } else {
                Outcome.Images(images)
            }
            main.post {
                // 会话可能已被取消/销毁取代：只有仍是当前会话才交付结果。
                if (this.session === session) finish(outcome)
            }
        }.apply { name = "bot-image-picker"; isDaemon = true }.start()
    }

    private fun decode(uri: Uri): JSONObject {
        val resolver = activity.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        } catch (t: Throwable) {
            throw PickerException("DECODE_FAILED", "无法读取所选图片")
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw PickerException("DECODE_FAILED", "所选内容不是可解码的图片")
        }
        // 框架 ExifInterface 覆盖 JPEG（相机与图库主流来源）；非 JPEG 读取失败按无方向处理。
        val orientation = try {
            resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (t: Throwable) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val rotated = orientation == ExifInterface.ORIENTATION_ROTATE_90
            || orientation == ExifInterface.ORIENTATION_ROTATE_270
            || orientation == ExifInterface.ORIENTATION_TRANSPOSE
            || orientation == ExifInterface.ORIENTATION_TRANSVERSE
        val effectiveW = if (rotated) bounds.outHeight else bounds.outWidth
        val effectiveH = if (rotated) bounds.outWidth else bounds.outHeight
        // bounds 先采样：除了长边上限，也按像素预算避免 16384² 级别的巨大 Bitmap。
        var sample = 1
        while (max(effectiveW, effectiveH) / sample > 2 * MAX_DIM ||
               (effectiveW.toLong() / sample) * (effectiveH.toLong() / sample) > MAX_PIXELS) {
            sample *= 2
        }
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        var bitmap = try {
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        } catch (t: Throwable) {
            null
        } ?: throw PickerException("DECODE_FAILED", "无法解码所选图片")
        bitmap = applyOrientation(bitmap, orientation)
        bitmap = fitWithin(bitmap, MAX_DIM)
        // 采样后仍可能超像素预算（极端宽高比）：再按 √ 比例缩一次，只防内存不报错。
        if (bitmap.width.toLong() * bitmap.height.toLong() > MAX_PIXELS) {
            bitmap = scale(bitmap, sqrt(MAX_PIXELS.toDouble() / (bitmap.width.toDouble() * bitmap.height)).toFloat())
        }

        // 源为 PNG 且未超限时保留 PNG；其余一律重编码 JPEG 并降质/缩尺寸至 ≤16MB。
        try {
            val sourceIsPng = bounds.outMimeType == "image/png"
            var outMime = if (sourceIsPng) MIME_PNG else MIME_JPEG
            var encoded = if (sourceIsPng) encodePng(bitmap) else encodeJpeg(bitmap, JPEG_START_QUALITY)
            if (encoded.size > MAX_BYTES && outMime == MIME_PNG) {
                outMime = MIME_JPEG
                encoded = encodeJpeg(bitmap, JPEG_START_QUALITY)
            }
            var quality = JPEG_START_QUALITY
            var attempts = 0
            while (encoded.size > MAX_BYTES && attempts < MAX_ENCODE_ATTEMPTS) {
                attempts++
                if (quality > JPEG_MIN_QUALITY) {
                    quality -= 10
                } else {
                    bitmap = scale(bitmap, SHRINK_FACTOR)
                    quality = JPEG_MIN_QUALITY
                }
                encoded = encodeJpeg(bitmap, quality)
            }
            if (encoded.size > MAX_BYTES) {
                throw PickerException("TOO_LARGE", "图片压缩后仍超过 16MB")
            }

            val image = JSONObject()
            image.put("name", displayName(uri, outMime))
            image.put("mimeType", outMime)
            image.put("data", Base64.encodeToString(encoded, Base64.NO_WRAP))
            image.put("size", encoded.size)
            image.put("width", bitmap.width)
            image.put("height", bitmap.height)
            return image
        } finally {
            bitmap.recycle()
        }
    }

    private fun applyOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                matrix.setRotate(180f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(-90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        return try {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (rotated !== bitmap) bitmap.recycle()
            rotated
        } catch (t: Throwable) {
            bitmap
        }
    }

    private fun fitWithin(bitmap: Bitmap, maxDim: Int): Bitmap {
        val largest = max(bitmap.width, bitmap.height)
        if (largest <= maxDim) return bitmap
        return scale(bitmap, maxDim.toFloat() / largest)
    }

    private fun scale(bitmap: Bitmap, factor: Float): Bitmap {
        val width = max(1, (bitmap.width * factor).roundToInt())
        val height = max(1, (bitmap.height * factor).roundToInt())
        val scaled = Bitmap.createScaledBitmap(bitmap, width, height, true)
        if (scaled !== bitmap) bitmap.recycle()
        return scaled
    }

    private fun encodePng(bitmap: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    private fun encodeJpeg(bitmap: Bitmap, quality: Int): ByteArray {
        // JPEG 无 alpha：透明底先合成白色，避免输出黑底。
        val source = if (bitmap.hasAlpha()) flatten(bitmap) else bitmap
        val out = ByteArrayOutputStream()
        source.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (source !== bitmap) source.recycle()
        return out.toByteArray()
    }

    private fun flatten(bitmap: Bitmap): Bitmap {
        val flat = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(flat)
        canvas.drawColor(Color.WHITE)
        canvas.drawBitmap(bitmap, 0f, 0f, null)
        return flat
    }

    /** 展示名：剥离原扩展后按输出 mime 补 .jpg/.png，UTF-8 ≤256B 不切代理对，保底非空。 */
    private fun displayName(uri: Uri, mimeType: String): String {
        var name = queryDisplayName(uri) ?: uri.lastPathSegment ?: ""
        name = name.trim()
        val dot = name.lastIndexOf('.')
        if (dot > 0) name = name.substring(0, dot)
        if (name.isEmpty()) name = "image"
        val ext = if (mimeType == MIME_PNG) ".png" else ".jpg"
        val budget = MAX_NAME_BYTES - ext.toByteArray(Charsets.UTF_8).size
        val sb = StringBuilder()
        var bytes = 0
        var index = 0
        while (index < name.length) {
            val codePoint = Character.codePointAt(name, index)
            val ch = String(Character.toChars(codePoint))
            val n = ch.toByteArray(Charsets.UTF_8).size
            if (bytes + n > budget) break
            sb.append(ch)
            bytes += n
            index += Character.charCount(codePoint)
        }
        return (if (sb.isEmpty()) "image" else sb.toString()) + ext
    }

    private fun queryDisplayName(uri: Uri): String? {
        try {
            activity.contentResolver
                .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val name = cursor.getString(0)
                        if (!name.isNullOrBlank()) return name
                    }
                }
        } catch (t: Throwable) { /* 名称仅用于展示 */ }
        return null
    }

    private companion object {
        const val SOURCE_CAMERA = "camera"
        const val MAX_IMAGES = 16
        const val MAX_DIM = 16384
        const val MAX_BYTES = 16 * 1024 * 1024
        // 解码软像素预算：超预算自动采样/缩放保护内存，不对可缩放来源报错。
        const val MAX_PIXELS = 32L * 1024 * 1024
        const val MAX_TOTAL_BYTES = 64L * 1024 * 1024
        const val JPEG_START_QUALITY = 90
        const val JPEG_MIN_QUALITY = 40
        const val MAX_ENCODE_ATTEMPTS = 24
        const val MAX_NAME_BYTES = 256
        const val SHRINK_FACTOR = 0.85f
        const val MIME_JPEG = "image/jpeg"
        const val MIME_PNG = "image/png"
    }
}
