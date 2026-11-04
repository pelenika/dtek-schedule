import { chromium } from "playwright"

import {
  checkIsNight,
  createPeriod,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
  deleteLastMessage,
  useSchedule,
} from "./helpers.js"
import {
  GROUP,
  hours,
  PowerState,
  SHUTDOWNS_DATA_MATCHER,
  SHUTDOWNS_PAGE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRIES_TIMEOUT,
  RETRIES_MAX_COUNT,
} from "./constants.js"

let sendNotificationRetries = 0
let getShutdownsDataRetries = 0

const getShutdownsData = async () => {
  console.log("🌀 Getting shutdowns data...")

  const browser = await chromium.launch({ headless: true })

  try {
    const browserPage = await browser.newPage()
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const html = await browserPage.content()
    const match = html.match(SHUTDOWNS_DATA_MATCHER)

    if (!match) {
      throw new Error("not found")
    }

    const data = JSON.parse(match[1])
    console.log("✅ Getting shutdowns data finished.")
    return data
  } catch (error) {
    console.error(`❌ Getting shutdowns data failed: ${error.message}.`)
  } finally {
    await browser.close()
  }

  if (getShutdownsDataRetries < RETRIES_MAX_COUNT) {
    console.log("🌀 Try getting shutdowns data again...")
    await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
    getShutdownsDataRetries++
    return await getShutdownsData()
  }

  throw Error(
    `❌ Getting shutdowns data failed after ${RETRIES_MAX_COUNT} retries.`
  )
}

function generateSchedule({ data, today }) {
  console.log("🌀 Generating schedule...")

  try {
    const hoursStates = data[today][GROUP]
    if (!hoursStates) throw Error(`group ${GROUP} not found`)
    const [schedule, setSchedule] = useSchedule([])

    hours.forEach((hour) => {
      const state = hoursStates[hour + 1]

      switch (state) {
        case PowerState.ON:
          setSchedule(createPeriod({ hour, power: true }))
          break

        case PowerState.OFF:
          setSchedule(createPeriod({ hour, power: false }))
          break

        case PowerState.HALF_ON:
          setSchedule(createPeriod({ hour, endMin: 30, power: true }))
          setSchedule(createPeriod({ hour, startMin: 30, power: false }))
          break

        case PowerState.HALF_OFF:
          setSchedule(createPeriod({ hour, endMin: 30, power: false }))
          setSchedule(createPeriod({ hour, startMin: 30, power: true }))
          break
      }
    })

    console.log("✅ Generating schedule finished.")

    return schedule
  } catch (error) {
    throw Error(`❌ Generating schedule failed: ${error.message}.`)
  }
}

function generateMessage(schedule = [], update) {
  console.log("🌀 Generating message...")

  const isShutdownsExists = schedule.some(({ power }) => !power)
  isShutdownsExists
    ? console.log("🪫 Power shutdowns detected!")
    : console.log("🔋 No power shutdowns!")

  const scheduleText = [
    ...(isShutdownsExists
      ? schedule
          .filter(({ power }) => !power)
          .map(({ begin, end }) => `🪫 <code>${begin} — ${end}</code>`)
      : schedule.map(({ begin, end }) => `🔋 <code>${begin} — ${end}</code>`)),
  ].join("\n")

  const text = [
    `⚡️ <b>Графік відключень на завтра:</b>`,
    scheduleText,
    "",
    `📢 <i>${update}</i>`,
    `🤖 <i>${getCurrentTime()}</i>`,
  ].join("\n")

  return { text, scheduleText }
}


async function sendNotification({ text, scheduleText }, scheduleDate) {
  if (!TELEGRAM_BOT_TOKEN) throw Error("Missing telegram bot token.")
  if (!TELEGRAM_CHAT_ID) throw Error("Missing telegram chat id.")

  const lastMessage = loadLastMessage() || {}

  if (
    lastMessage.scheduleDate === scheduleDate &&
    lastMessage.scheduleText === scheduleText
  ) {
    console.log("🟡 Schedule unchanged. Skipping notification.")
    return
  }

  const isUpdate =
    lastMessage.scheduleDate === scheduleDate &&
    lastMessage.scheduleText !== scheduleText

  const finalText = isUpdate
    ? "🔄 <b>Оновлений графік</b>\n\n" + text
    : text

  for (let attempt = 1; attempt <= RETRIES_MAX_COUNT; attempt++) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: finalText,
            parse_mode: "HTML",
            disable_notification: checkIsNight(),
          }),
        }
      )

      const result = await response.json()

      if (!result.ok) {
        throw Error(result.description || "Telegram error")
      }

      saveLastMessage({
        ...result.result,
        scheduleText,
        scheduleDate,
      })

      console.log("🟢 Notification sent.")
      return
    } catch (error) {
      console.error(`Attempt ${attempt}: ${error.message}`)

      if (attempt === RETRIES_MAX_COUNT) throw error

      await new Promise((resolve) =>
        setTimeout(resolve, RETRIES_TIMEOUT)
      )
    }
  }
}


async function run() {
  const now = new Date()

  const kyivHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Kyiv",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now)
  )

  if (kyivHour < 21) {
    console.log("🟡 Before 21:00 Kyiv. Skipping.")
    return
  }

  const data = await getShutdownsData()
  const tomorrow = String(Number(data.today) + 86400)

  if (!data.data?.[tomorrow]?.[GROUP]) {
    console.log("🟡 Tomorrow schedule not published yet.")
    return
  }

  const schedule = generateSchedule({
    data: data.data,
    today: tomorrow,
  })

  const message = generateMessage(schedule, data.update)

  await sendNotification(message, tomorrow)
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
