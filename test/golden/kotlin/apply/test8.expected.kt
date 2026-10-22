// [INSERT] новая ветка when в теле-выражении
package settings

import kotlin.math.max

sealed class Result {
    data class Ok(val value: String) : Result()
    data class Fail(val reason: String) : Result()
}

data class Setting(
    val key: String,
    val value: String,
    val secret: Boolean = false,
)

class Repository(private val source: Map<String, String>) {

    private val cache = mutableMapOf<String, Setting>()

    companion object {
        const val DEFAULT_TTL = 300

        fun empty() = Repository(emptyMap())
    }

    init {
        require(source.isNotEmpty()) { "source must not be empty" }
    }

    val size get() = cache.size

    fun load(key: String): Result = when {
        key.isBlank() -> Result.Fail("blank key")
        key.length > 64 -> Result.Fail("key too long")
        key in cache -> Result.Ok(cache.getValue(key).value)
        else -> Result.Fail("missing")
    }

    fun warm(keys: List<String>) {
        keys.forEach { key ->
            source[key]?.let { raw ->
                cache[key] = Setting(key, raw.trim())
            }
        }
    }

    fun describe(setting: Setting) = "${setting.key} = ${setting.value}"

    fun ttlFor(key: String) = max(DEFAULT_TTL, key.length * 10)
}

fun String.squeeze(): String {
    return trim().replace(Regex("\s+"), " ")
}

infix fun Int.upTo(other: Int): IntRange = this..other
