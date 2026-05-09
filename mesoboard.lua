plugin = {
    name        = "Hyeong's Mesoboard Tracker",
    version     = "1.8.0",
    description = "meso + items 전송 전용",
    load        = true
}

local OWNER            = "Hyeong"
local TOKEN            = "fd9601cc2d89007ea64825510908023994b55e445d8d930ed582f7a8532afe30"
local URL              = "https://hyeong.up.railway.app/api/tracker"
local INTERVAL_MS      = 30000  -- 30초 (10초→30초: 계산 안정성 향상)
local STARTUP_DELAY_MS = 10000  -- 10초 대기 (첫 샘플이 안정된 후 전송 시작)
local WINDOW_MS        = 360000 -- 6분 슬라이딩 윈도우 (30초 기준 12샘플)

-- 허용 최대 meso 상승폭 (구간당): 350m/hr × (30s / 3600) ≈ 2.9m → 여유있게 8m
-- 이 이상이면 메소 수동 추가·재로그인으로 간주하고 히스토리 리셋
local MAX_DIFF_MESO = 8000000

local TRACK_ITEMS = {
    { id = 2120000, name = "펫먹이" },
    { id = 2000039, name = "연료" },
    { id = 2003611, name = "재획" },
    { id = 4009550, name = "조각" },
    { id = 4001832, name = "주흔" },
    { id = 5130000, name = "elixir" },
    { id = 2433834, name = "chest" },
    { id = 2830545, name = "box" },
    { id = 2048716, name = "flame" },
    { id = 2048717, name = "eternal_flame" },
    { id = 2048753, name = "black_flame" },
    { id = 2636135, name = "arcane" },
    { id = 2636141, name = "cer_sac" },
    { id = 2636142, name = "arcus_sac" },
    { id = 2636318, name = "ordium_sac" },
    { id = 2636319, name = "shang_sac" },
    { id = 5132000, name = "safety_charm" },
}

local http       = core.http.client()
local last_sent  = 0
local start_time = nil
local history    = {}

-- ────────────────────────────────────────────────
-- Violet 3.5.0+ 버그: meso가 "integer: 0xHEX" userdata로 반환됨
-- ────────────────────────────────────────────────
local function int64_to_number(v)
    if v == nil then return 0 end
    if type(v) == "number" then return v end
    local s = tostring(v)
    local hex = s:match("0x(%x+)")
    if hex then return tonumber(hex, 16) or 0 end
    return tonumber(s) or 0
end

local function now_ms()
    return core.get_system_time().epoch
end

local function esc(s)
    if not s then return "" end
    return tostring(s):gsub("\\","\\\\"):gsub('"','\\"'):gsub("\n","\\n")
end

local function get_count(id)
    local total = 0
    for _, tab in ipairs({
        core.inventory.get_use_items(),
        core.inventory.get_etc_items(),
        core.inventory.get_cash_items(),
    }) do
        if tab then
            for _, item in ipairs(tab) do
                if item.id == id then total = total + (item.count or 1) end
            end
        end
    end
    return total
end

-- ────────────────────────────────────────────────
-- meso/hr — 6분 슬라이딩 윈도우 (30초 간격 기준 12샘플)
-- MAX_DIFF_MESO 초과 시 히스토리 리셋 (재로그인·수동추가 감지)
-- ────────────────────────────────────────────────
local function update_history(current_meso)
    local now = now_ms()
    if #history > 0 then
        local diff = current_meso - history[#history].meso
        -- 메소가 크게 올랐거나 떨어진 경우 리셋
        if diff > MAX_DIFF_MESO or diff < -1000000 then
            history = {}
            core.log(string.format(
                "[MesoTracker] meso 급변 감지 (diff=%.0f) — 6min window 리셋", diff))
        end
    end
    table.insert(history, { time = now, meso = current_meso })
    -- 6분 윈도우 밖 샘플 제거
    while #history > 0 and (now - history[1].time) > WINDOW_MS do
        table.remove(history, 1)
    end
end

local function calculate_meso_hr()
    if #history < 2 then return 0 end
    local first      = history[1]
    local last       = history[#history]
    local elapsed_ms = last.time - first.time
    -- 최소 25초 이상 경과해야 계산 (30초 간격이므로 첫 사이클 안전마진)
    if elapsed_ms < 25000 then return 0 end
    local meso_diff  = last.meso - first.meso
    if meso_diff < 0 then return 0 end
    return math.floor((meso_diff / elapsed_ms) * 3600000)
end

-- ────────────────────────────────────────────────
-- JSON payload 빌드
-- ────────────────────────────────────────────────
local function build(player)
    local ign   = player:get_name() or ""
    local level = player:get_level() or 0
    local job   = player:get_job() or 0
    local meso  = int64_to_number(player:get_meso())

    update_history(meso)
    local meso_hr = calculate_meso_hr()

    core.log(string.format("[Mesoboard] ign=%s  meso=%.0f  meso_hr=%.0f  samples=%d",
        ign, meso, meso_hr, #history))

    local items = "["
    for i, item in ipairs(TRACK_ITEMS) do
        if i > 1 then items = items .. "," end
        items = items .. string.format(
            '{"id":%d,"name":"%s","count":%d}',
            item.id, esc(item.name), get_count(item.id)
        )
    end
    items = items .. "]"

    return '{"owner":"'  .. esc(OWNER)
        .. '","token":"'  .. esc(TOKEN)
        .. '","ign":"'    .. esc(ign)
        .. '","level":'   .. tostring(level)
        .. ',"job":'      .. tostring(job)
        .. ',"meso":'     .. string.format("%.0f", meso)
        .. ',"meso_hr":'  .. string.format("%.0f", meso_hr)
        .. ',"items":'    .. items
        .. '}'
end

-- ────────────────────────────────────────────────
-- 메인 루프
-- ────────────────────────────────────────────────
function on_tick()
    local t = core.get_update_time()

    if start_time == nil then start_time = t end
    if t - start_time < STARTUP_DELAY_MS then return end

    if t - last_sent < INTERVAL_MS then return end

    local player = core.object_manager.get_local_player()
    if not player or not player:is_valid() then return end

    last_sent = t
    http:post(URL, build(player), "application/json", function(r)
        if not r then
            core.log_warning("[Mesoboard] 응답 없음")
            return
        end
        if r.status == 0 then
            core.log_warning("[Mesoboard] 전송 실패 (rate-limit or network)")
            return
        end
        if r.status and r.status >= 400 then
            core.log_warning(string.format("[Mesoboard] HTTP %d", r.status))
            return
        end
        core.log("[Mesoboard] OK ✓")
    end)
end

core.log("[Mesoboard] v1.8.0 Ready ✓ (30s interval)")
