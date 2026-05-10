plugin = {
    name        = "Hyeong's Mesoboard Tracker",
    version     = "2.1.0",
    description = "meso + items + 사망감지(buff 11) 전송 + 서버 교차검증",
    load        = true
}

local OWNER            = "Hyeong"
local TOKEN            = "fd9601cc2d89007ea64825510908023994b55e445d8d930ed582f7a8532afe30"
local URL              = "https://hyeong.up.railway.app/api/tracker"
local INTERVAL_MS      = 30000
local STARTUP_DELAY_MS = 10000
local WINDOW_MS        = 360000

local MAX_DIFF_MESO = 6000000
local MESO_HR_CAP   = 400000000

local DEAD_BUFF_ID  = 11  -- 사망 시 부여되는 비석 버프

local TRACK_ITEMS = {
    { id = 2120000, name = "펫먹이"      },
    { id = 2000039, name = "연료"        },
    -- id 2003611 = 재물 획득의 물약 (WAP/재획) — 이름을 "재획"으로 통일
    { id = 2003611, name = "재획"        },
    { id = 4009550, name = "조각"        },
    { id = 4001832, name = "주흔"        },
    { id = 5130000, name = "elixir"      },
    { id = 2433834, name = "chest"       },
    { id = 2830545, name = "box"         },
    { id = 2048716, name = "flame"       },
    { id = 2048717, name = "eternal_flame" },
    { id = 2048753, name = "black_flame" },
    { id = 2636135, name = "arcane"      },
    { id = 2636141, name = "cer_sac"     },
    { id = 2636142, name = "arcus_sac"   },
    { id = 2636318, name = "ordium_sac"  },
    { id = 2636319, name = "shang_sac"   },
    { id = 5132000, name = "safety_charm"},
}

local http       = core.http.client()
local last_sent  = 0
local start_time = nil
local history    = {}

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

local function update_history(current_meso)
    local now = now_ms()
    if #history > 0 then
        local prev  = history[#history]
        local diff  = current_meso - prev.meso
        local dt_ms = now - prev.time
        if diff > MAX_DIFF_MESO or diff < -1000000 then
            history = {}
            core.log(string.format("[MesoTracker] meso 급변 (diff=%.0f) — 리셋", diff))
            table.insert(history, { time = now, meso = current_meso })
            return
        end
        if dt_ms > 90000 then
            history = {}
            core.log("[MesoTracker] 90초 갭 감지 — 리셋")
        end
    end
    table.insert(history, { time = now, meso = current_meso })
    while #history > 0 and (now - history[1].time) > WINDOW_MS do
        table.remove(history, 1)
    end
end

local function calculate_meso_hr()
    if #history < 2 then return 0 end
    local first      = history[1]
    local last_entry = history[#history]
    local elapsed_ms = last_entry.time - first.time
    if elapsed_ms < 25000 then return 0 end
    local meso_diff = last_entry.meso - first.meso
    if meso_diff < 0 then return 0 end
    return math.min(math.floor((meso_diff / elapsed_ms) * 3600000), MESO_HR_CAP)
end

local function build(player)
    local ign   = player:get_name() or ""
    local level = player:get_level() or 0
    local job   = player:get_job() or 0
    local meso  = int64_to_number(player:get_meso())

    update_history(meso)
    local meso_hr = calculate_meso_hr()

    -- 사망 감지: buff 11 보유 시 buff_count=11 전송
    local is_dead    = player:has_buff(DEAD_BUFF_ID)
    local buff_count = is_dead and 11 or 0
    if is_dead then core.log("[MesoTracker] ⚠️ 사망 감지 — buff_count=11 전송") end

    core.log(string.format("[Mesoboard] %s  meso=%.0f  hr=%.0f  samples=%d  dead=%s",
        ign, meso, meso_hr, #history, tostring(is_dead)))

    local items = "["
    for i, item in ipairs(TRACK_ITEMS) do
        if i > 1 then items = items .. "," end
        items = items .. string.format(
            '{"id":%d,"name":"%s","count":%d}',
            item.id, esc(item.name), get_count(item.id)
        )
    end
    items = items .. "]"

    return '{"owner":"'    .. esc(OWNER)
        .. '","token":"'   .. esc(TOKEN)
        .. '","ign":"'     .. esc(ign)
        .. '","level":'    .. tostring(level)
        .. ',"job":'       .. tostring(job)
        .. ',"meso":'      .. string.format("%.0f", meso)
        .. ',"meso_hr":'   .. string.format("%.0f", meso_hr)
        .. ',"buff_count":' .. tostring(buff_count)
        .. ',"items":'     .. items
        .. '}'
end

function on_tick()
    local t = core.get_update_time()
    if start_time == nil then start_time = t end
    if t - start_time < STARTUP_DELAY_MS then return end
    if t - last_sent  < INTERVAL_MS      then return end

    local player = core.object_manager.get_local_player()
    if not player or not player:is_valid() then return end

    last_sent = t
    http:post(URL, build(player), "application/json", function(r)
        if not r then core.log_warning("[Mesoboard] 응답 없음"); return end
        if r.status == 0 then core.log_warning("[Mesoboard] 전송 실패"); return end
        if r.status and r.status >= 400 then
            core.log_warning(string.format("[Mesoboard] HTTP %d", r.status)); return
        end
        core.log("[Mesoboard] OK ✓")
    end)
end

core.log("[Mesoboard] v2.1.0 Ready ✓ (재획=WAP 통일, charm 추가, dead-buff)")
