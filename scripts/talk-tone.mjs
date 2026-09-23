#!/usr/bin/env node
/**
 * Standalone two-way-audio check: plays a generated tone through a Reolink
 * camera's speaker over Baichuan talk, using @apocaliss92/nodelink-js directly
 * and the same calls the plugin's intercom engine makes (TalkAbility ->
 * createDedicatedTalkSession -> IMA ADPCM blocks -> stop). No Scrypted involved,
 * so it isolates the protocol path from WebRTC and mixins.
 *
 * Usage (from the repo root, after `npm install`):
 *
 *   REOLINK_HOST=192.168.1.50 REOLINK_USER=admin REOLINK_PASS=... \
 *   REOLINK_UID=9527000XXXXXXXXX node scripts/talk-tone.mjs
 *
 * Env:
 *   REOLINK_HOST       camera IP (required)
 *   REOLINK_USER       username (default: admin)
 *   REOLINK_PASS       password (required)
 *   REOLINK_UID        camera UID; required for UDP (battery/WiFi) cameras
 *   REOLINK_TRANSPORT  udp | tcp (default: udp when REOLINK_UID is set, else tcp)
 *   REOLINK_UDP_DISCOVERY  udpDiscoveryMethod passed to the library (optional,
 *                      e.g. local-direct — match the plugin's setting)
 *   REOLINK_CHANNEL    channel (default: 0)
 *   TONE_HZ            tone frequency (default: 660)
 *   TONE_SECONDS       tone length (default: 3)
 *   TONE_GAIN          0..1 amplitude (default: 0.5)
 *
 * Doorbells echo-cancel their own speaker, so listen at the device rather than
 * in its audio feed.
 */
import { ReolinkBaichuanApi, encodeImaAdpcm } from "@apocaliss92/nodelink-js";

const env = process.env;
const host = env.REOLINK_HOST;
const password = env.REOLINK_PASS;
if (!host || !password) {
  console.error("REOLINK_HOST and REOLINK_PASS are required (see header).");
  process.exit(2);
}
const username = env.REOLINK_USER || "admin";
const uid = env.REOLINK_UID?.trim() || undefined;
const transport = env.REOLINK_TRANSPORT || (uid ? "udp" : "tcp");
const channel = Number(env.REOLINK_CHANNEL ?? 0);
const toneHz = Number(env.TONE_HZ ?? 660);
const toneSeconds = Number(env.TONE_SECONDS ?? 3);
const toneGain = Math.max(0, Math.min(1, Number(env.TONE_GAIN ?? 0.5)));

if (transport === "udp" && !uid) {
  console.error("REOLINK_UID is required for UDP transport.");
  process.exit(2);
}

const logger = console;
const api = new ReolinkBaichuanApi({
  host,
  username,
  password,
  logger,
  transport,
  ...(transport === "udp"
    ? {
        uid,
        ...(env.REOLINK_UDP_DISCOVERY
          ? { udpDiscoveryMethod: env.REOLINK_UDP_DISCOVERY }
          : {}),
      }
    : {}),
});
api.client.on("error", (e) => logger.warn("[client error]", e?.message ?? e));

let session;
try {
  await api.login();
  logger.log(`Logged in (${transport}) to ${host}`);

  if (transport === "udp") {
    try {
      await api.wakeUp(channel, { waitAfterWakeMs: 2000 });
      logger.log("Wake-up sent");
    } catch (e) {
      logger.warn("Wake-up failed, continuing:", e?.message ?? e);
    }
  }

  const ability = await api.getTalkAbility(channel);
  logger.log("TalkAbility", JSON.stringify(ability));

  session = await api.createDedicatedTalkSession(channel, {
    deviceId: "talk-tone",
    logger,
  });
  const { audioConfig, blockSize, fullBlockSize } = session.info;
  logger.log("Talk session open", {
    audioType: audioConfig.audioType,
    sampleRate: audioConfig.sampleRate,
    lengthPerEncoder: audioConfig.lengthPerEncoder,
    blockSize,
    fullBlockSize,
  });

  // Same framing as src/intercom.ts: one IMA ADPCM block carries
  // blockSize * 2 + 1 samples (header sample + two nibbles per byte).
  const sampleRate = audioConfig.sampleRate;
  const samplesPerBlock = blockSize * 2 + 1;
  const totalSamples = Math.floor(sampleRate * toneSeconds);
  const amplitude = Math.round(32767 * toneGain);

  let sent = 0;
  for (let off = 0; off < totalSamples; off += samplesPerBlock) {
    const pcm = new Int16Array(samplesPerBlock);
    for (let i = 0; i < samplesPerBlock; i++) {
      const n = off + i;
      pcm[i] =
        n < totalSamples
          ? Math.round(amplitude * Math.sin((2 * Math.PI * toneHz * n) / sampleRate))
          : 0;
    }
    // sendAudio paces itself to real time, so this loop plays at 1x.
    await session.sendAudio(encodeImaAdpcm(pcm, blockSize));
    if (sent++ === 0) logger.log("First audio block sent");
  }
  logger.log(`Sent ${sent} blocks (~${toneSeconds}s of ${toneHz} Hz)`);
} catch (e) {
  logger.error("Talk test failed:", e?.stack ?? e);
  process.exitCode = 1;
} finally {
  try {
    await session?.stop();
    logger.log("Talk session stopped");
  } catch (e) {
    logger.warn("Talk stop error:", e?.message ?? e);
  }
  try {
    await api.close({ reason: "talk-tone done" });
  } catch {
    // ignore
  }
}
