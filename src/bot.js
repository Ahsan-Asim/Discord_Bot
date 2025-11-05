import dotenv from "dotenv";
import fs from "fs";
import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus } from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";
import prism from "prism-media";
import { pipeline } from "stream";
import wav from "wav";
import OpenAI from "openai";
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} from "@discordjs/voice";


dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ================== CLIENT READY ==================
client.once("clientReady", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.on("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.first();
  if (!guild) return console.error("❌ No guild found.");

  const member = guild.members.cache.find((m) => m.user.username === "ahsan094758");
  if (!member) return console.error("❌ User not found in guild.");

  if (member.voice?.channel) {
    const connection = joinVoiceChannel({
      channelId: member.voice.channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    // ✅ Handle voice connection lifecycle
    connection.on("error", (err) => {
      console.error("⚠️ Voice connection error:", err.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      console.log("🔌 Disconnected from voice channel.");
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log("💥 Voice connection destroyed.");
    });

    console.log("✅ Joined voice channel successfully!");
    attachVoiceListener(connection, member.id, member);
  } else {
    console.log("❌ User is not in a voice channel.");
  }
});

// ================== PLAY AUDIO IN VC ==================
async function playAudioInVC(connection, filePath) {
  try {
    const player = createAudioPlayer();
    const resource = createAudioResource(fs.createReadStream(filePath));

    connection.subscribe(player);
    player.play(resource);

    console.log("🎧 Playing response in voice channel...");

    player.on(AudioPlayerStatus.Playing, () => {
      console.log("🎙️ Bot is speaking...");
    });

    player.on(AudioPlayerStatus.Idle, () => {
      console.log("✅ Finished speaking.");
      player.stop();
    });
  } catch (err) {
    console.error("❌ Error playing audio in voice channel:", err);
  }
}

// ================== VOICE LISTENER ==================
function attachVoiceListener(connection, userId, member) {
  const receiver = connection.receiver;

  receiver.speaking.on("start", async (id) => {
    if (id !== userId) return;
    console.log(`🎙️ ${member.user.username} started speaking...`);

    const opusStream = receiver.subscribe(id, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 4500 }, // wait longer for silence
      mode: "opus",
    });

    const wavPath = `./temp_${userId}_${Date.now()}.wav`;

    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 1,
      rate: 48000,
    });

    const wavWriter = new wav.FileWriter(wavPath, {
      sampleRate: 48000,
      channels: 1,
    });

    // Use one clean pipeline
    pipeline(opusStream, decoder, wavWriter, async (err) => {
      if (err) {
        console.error("❌ Stream pipeline error:", err);
        return;
      }

      console.log("⏹️ Silence detected — finalizing recording...");
      await new Promise((res) => setTimeout(res, 800)); // small buffer time

      try {
        console.log(`💾 Saved WAV: ${wavPath}`);
        const transcription = await transcribeAudio(wavPath);
        console.log(`📝 ${member.user.username} says: "${transcription}"`);

        const reply = await getGPTReply(transcription);
        console.log(`💬 GPT reply: "${reply}"`);

        await textToSpeech(reply);
        await playAudioInVC(connection, "response.mp3");

        if (fs.existsSync(wavPath)) {
          fs.unlinkSync(wavPath);
          console.log("🧹 Deleted temp WAV file.");
        }
      } catch (err) {
        console.error("❌ Error processing voice:", err);
      }
    });
  });
}


// ================== OPENAI WHISPER ==================
async function transcribeAudio(filePath) {
  console.log("🗣️ Sending audio to Whisper...");
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "gpt-4o-mini-transcribe",
    language: "en", // Force English
  });
  console.log("✅ Transcription received.");
  return resp.text.trim();
}

// ================== OPENAI GPT ==================
async function getGPTReply(text) {
  if (!text || text.length < 2) return "Sorry, I didn’t catch that clearly.";
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a friendly AI assistant in a Discord voice chat." },
      { role: "user", content: text },
    ],
  });
  return resp.choices[0].message.content.trim();
}

// ================== TEXT TO SPEECH ==================
async function textToSpeech(text) {
  console.log("🔊 Converting text to speech...");
  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "onyx",
    input: text,
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  fs.writeFileSync("response.mp3", buffer);
  console.log("✅ Saved response.mp3");
}

// ================== START BOT ==================
client.login(process.env.DISCORDJS_BOT_TOKEN);
