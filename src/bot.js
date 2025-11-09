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
import { createClient } from "@supabase/supabase-js";
import { Events } from "discord.js";
import { google } from "googleapis";
import { getVoiceConnection } from "@discordjs/voice";




dotenv.config();


// Google Sheets auth
const sheetsAuth = new google.auth.GoogleAuth({
  keyFile: "./service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SPREADSHEET_ID = "1-BtbZrrWtQUmOUzMtQU_KhRLF0QEDd8RVrYZCA7F04I";
const SHEET_NAME = "Sheet1";

async function appendToSheet(values = []) {
  try {
    const client = await sheetsAuth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });

    console.log("Data appended to Google Sheet:", values);
  } catch (err) {
    console.error("Google Sheets append error:", err);
  }
}


// ------------------- Supabase -------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function getSupabaseContext(channel) {
  try {
    const { data, error } = await supabase
      .from("bot_messages")
      .select("content")
      .eq("channel", channel)
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) {
      console.error("Supabase read error:", error.message);
      await logErrorToSupabase("fetching context", error.message, { channel });
      return [];
    }

    return data.map((row) => row.content);
  } catch (err) {
    console.error("Supabase fetch failed:", err);
    await logErrorToSupabase("fetching context", err.message, { channel });
    return [];
  }
}

async function logErrorToSupabase(context, error, details = {}) {
  try {
    await supabase.from("bot_errors").insert([{ context, error, details }]);
  } catch (err) {
    console.error("Failed to log error to Supabase:", err);
  }
}

async function logMessageToSupabase(channel, direction, userRef, content, metadata = {}) {
  try {
    await supabase.from("bot_messages").insert([
      { channel, direction, user_ref: userRef, content, metadata },
    ]);
  } catch (err) {
    console.error("Failed to log message:", err);
  }
}

// ------------------- Discord + OpenAI -------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, 
  ],
});


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------- CLIENT READY -------------------
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// client.on("ready", async () => {
//   console.log(`Logged in as ${client.user.tag}`);
  

//   const guild = client.guilds.cache.first();
//   if (!guild) return console.error("No guild found.");


//   // Replace with your channel ID or pick the first voice channel
// const voiceChannel = guild.channels.cache.get(process.env.VOICE_CHANNEL_ID);
// if (!voiceChannel || voiceChannel.type !== 2) return console.error("Voice channel not found.");

// // Join voice channel
// const connection = joinVoiceChannel({
//   channelId: voiceChannel.id,
//   guildId: guild.id,
//   adapterCreator: guild.voiceAdapterCreator,
//   selfDeaf: false,
// });

// connection.on("error", (err) => console.error("Voice connection error:", err.message));
// connection.on(VoiceConnectionStatus.Disconnected, () => console.log("Disconnected from VC."));
// connection.on(VoiceConnectionStatus.Destroyed, () => console.log("Voice connection destroyed."));

// console.log("Joined voice channel successfully!");

// });
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) return console.error("Guild not found.");

  const voiceChannel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID).catch(() => null);
  if (!voiceChannel || voiceChannel.type !== 2) return console.error("Voice channel not found.");

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  connection.on("error", (err) => console.error("Voice connection error:", err.message));
  connection.on(VoiceConnectionStatus.Disconnected, () => console.log("Disconnected from VC."));
  connection.on(VoiceConnectionStatus.Destroyed, () => console.log("Voice connection destroyed."));

  console.log("Joined voice channel successfully!");
});

client.on("voiceStateUpdate", (oldState, newState) => {
  // Ignore bot
  if (newState.member.user.bot) return;

  // Check if user joined the same VC as bot
const connection = getVoiceConnection(newState.guild.id);
  if (!connection) return;

  if (newState.channelId === connection.joinConfig.channelId) {
    console.log(`User joined VC: ${newState.member.user.username} (${newState.id})`);
    attachVoiceListener(connection, newState.member.id, newState.member);
  }
});


// ------------------- TEXT CHAT LISTENER -------------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const userText = message.content.toLowerCase();
  const channelId = message.channel.id;

  try {
    if (userText.includes("register") && userText.includes("schedule")) {
  await message.channel.send(
    "You want to register your schedule. Do you want to continue? Reply with **YES** to confirm."
  );

  const filter = (m) => m.author.id === message.author.id;

  const collected = await message.channel.awaitMessages({
    filter,
    max: 1,
    time: 30000,
    errors: ["time"],
  });

  const reply = collected.first().content.trim().toUpperCase();

  const userMessages = [];
  const botResponses = [];

  botResponses.push("You want to register your schedule. Do you want to continue? Reply with YES to confirm.");

  if (reply === "YES") {
    userMessages.push(collected.first().content);

    await message.channel.send(
      "Please provide your schedule details in one message:"
    );
    botResponses.push("Please provide your schedule details in one message:");

    const scheduleCollected = await message.channel.awaitMessages({
      filter,
      max: 1,
      time: 60000,
      errors: ["time"],
    });

    const scheduleText = scheduleCollected.first().content.trim();
    userMessages.push(scheduleText);

    botResponses.push("Your schedule has been registered in Google Sheets!");
    
    const rowData = [
      message.author.username,
      userMessages.join(" | "), 
      botResponses.join(" | ") 
    ];

    await appendToSheet(rowData);
    await message.channel.send("Your schedule has been registered in Google Sheets!");
  } else {
    userMessages.push(collected.first().content);
    botResponses.push("Registration cancelled.");

    const rowData = [
      message.author.username,
      userMessages.join(" | "),
      botResponses.join(" | ")
    ];
    await appendToSheet(rowData);

    await message.channel.send("Registration cancelled.");
  }

  return;
}


    //Normal GPT chat behavior
    const contextMessages = await getSupabaseContext(channelId);

    const messages = [
      {
        role: "system",
        content: "You are Hellgate, the dark, commanding voice of The Underground Market. Always confirm before taking actions."
      },
      ...contextMessages.map((msg) => ({ role: "system", content: msg })),
      { role: "user", content: message.content },
    ];

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const replyText = resp.choices[0].message.content.trim();

    await message.channel.send(replyText);
    await logMessageToSupabase(channelId, "outbound", "Hellgate", replyText);

  } catch (err) {
    console.error("Error processing text message:", err);
    await logErrorToSupabase("text message processing", err.message, { channelId });
    await message.channel.send("Something went wrong while processing your request.");
  }
});


// ------------------- PLAY AUDIO IN VC -------------------
async function playAudioInVC(connection, filePath) {
  try {
    const player = createAudioPlayer();
    const resource = createAudioResource(fs.createReadStream(filePath));

    connection.subscribe(player);
    player.play(resource);

    console.log("Playing response in voice channel...");

    player.on(AudioPlayerStatus.Playing, () => console.log("🎙️ Bot is speaking..."));
    player.on(AudioPlayerStatus.Idle, () => {
      console.log("Finished speaking.");
      player.stop();
    });
  } catch (err) {
    console.error("Error playing audio in voice channel:", err);
    await logErrorToSupabase("playAudioInVC", err.message);
  }
}


// Global flag object to track recording per user
const isRecording = {};

function attachVoiceListener(connection, userId, member) {
  const receiver = connection.receiver;
  console.log(`🎧 Listening to ${member.user.username}...`);

  const handleSpeaking = async (id) => {
    if (id !== userId) return;
    if (isRecording[userId]) return; // Prevent overlapping streams
    isRecording[userId] = true;

    console.log(`🎙️ ${member.user.username} started speaking...`);

    const opusStream = receiver.subscribe(id, {
      end: { behavior: EndBehaviorType.Manual },
      mode: "opus",
    });

    const wavPath = `./temp_${userId}_${Date.now()}.wav`;
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    const wavWriter = new wav.FileWriter(wavPath, { sampleRate: 48000, channels: 1 });
    decoder.on("error", (err) => console.error("Decoder error (ignored):", err.message));

    opusStream.pipe(decoder).pipe(wavWriter);

    // Stop recording after 2s of silence
    let silenceTimer;
    opusStream.on("data", () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => opusStream.emit("end"), 2000);
    });

    const finishWriting = new Promise((resolve, reject) => {
      wavWriter.on("finish", resolve);
      wavWriter.on("error", reject);
    });

    opusStream.on("end", () => {
      console.log("⏹️ Silence detected — finalizing recording...");
      opusStream.unpipe();
      decoder.end();
      wavWriter.end();
    });

    try {
      await finishWriting;
      console.log(`WAV saved: ${wavPath}`);

      const transcription = await transcribeAudio(wavPath);
      console.log(`${member.user.username} says: "${transcription}"`);

      if (!transcription || transcription.length < 1) {
        console.log("No transcription, ignoring this input.");
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        isRecording[userId] = false;
        attachListener();
        return;
      }

      // Handle Schedule Registration via Voice
      if (transcription.toLowerCase().includes("register") || transcription.toLowerCase().includes("schedule")) {
        await textToSpeech("You want to register a schedule. Do you want to continue? Please say YES to confirm.");
        await playAudioInVC(connection, "response.mp3");

        const confirm = await captureNextVoiceResponse(connection, userId);
        if (confirm.toLowerCase().includes("yes")) {
          await textToSpeech("Please say your name.");
          await playAudioInVC(connection, "response.mp3");
          const name = await captureNextVoiceResponse(connection, userId);

          await textToSpeech("Please say the date and time for your schedule.");
          await playAudioInVC(connection, "response.mp3");
          const dateTime = await captureNextVoiceResponse(connection, userId);

          const rowData = [name, dateTime, "Schedule registered via voice"];
          await appendToSheet(rowData);

          await textToSpeech("Your schedule has been successfully registered in Google Sheets!");
          await playAudioInVC(connection, "response.mp3");
        } else {
          await textToSpeech("Registration cancelled.");
          await playAudioInVC(connection, "response.mp3");
        }

        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        isRecording[userId] = false;
        attachListener();
        return;
      }

      // Normal GPT response
      const reply = await getGPTReply(transcription, member.voice.channel.id);
      console.log(`GPT reply: "${reply}"`);

      await textToSpeech(reply);
      await playAudioInVC(connection, "response.mp3");
      await logMessageToSupabase(member.voice.channel.id, "outbound", "Hellgate", reply);

    } catch (err) {
      console.error("Error processing voice:", err);
      await logErrorToSupabase("voice processing", err.message, { userId: member.id });
    } finally {
      if (fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
        console.log("🧹 Deleted temp WAV file.");
      }
      isRecording[userId] = false;
      attachListener(); // Ready for next speech
    }
  };

  const attachListener = () => receiver.speaking.once("start", handleSpeaking);
  attachListener();
}

function captureNextVoiceResponse(connection, userId) {
  return new Promise((resolve) => {
    const receiver = connection.receiver;
    const wavPath = `./response_${userId}_${Date.now()}.wav`;
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
      mode: "opus",
    });

    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    const wavWriter = new wav.FileWriter(wavPath, { sampleRate: 48000, channels: 1 });
    opusStream.pipe(decoder).pipe(wavWriter);

    let silenceTimer;
    opusStream.on("data", () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => opusStream.emit("end"), 2000);
    });

    opusStream.on("end", async () => {
      decoder.end();
      wavWriter.end();
    });

    wavWriter.on("finish", async () => {
      const text = await transcribeAudio(wavPath);
      console.log(`User said: "${text}"`);
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      resolve(text || "");
    });
  });
}



// ------------------- OPENAI WHISPER -------------------
async function transcribeAudio(filePath) {
  console.log("🗣️ Sending audio to Whisper...");
  try {
    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-mini-transcribe",
      language: "en",
    });
    console.log("Transcription received.");
    return resp.text.trim();
  } catch (err) {
    console.error("Whisper transcription failed:", err);
    await logErrorToSupabase("Whisper transcription", err.message);
    return "";
  }
}

// ------------------- OPENAI GPT -------------------
async function getGPTReply(text, channel) {
  if (!text || text.length < 2) return "Sorry, I didn’t catch that clearly.";

  const contextMessages = await getSupabaseContext(channel);

  const messages = [
    {
      role: "system",
      content: "You are Hellgate, the dark, commanding voice of The Underground Market. Always confirm before taking actions and give answer below 25 words."
    },
    ...contextMessages.map((msg) => ({ role: "system", content: msg })),
    { role: "user", content: text },
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });
    return resp.choices[0].message.content.trim();
  } catch (err) {
    console.error("GPT reply failed:", err);
    await logErrorToSupabase("GPT reply", err.message, { channel });
    return "Error generating response.";
  }
}

// ------------------- TEXT TO SPEECH -------------------
async function textToSpeech(text) {
  console.log("🔊 Converting text to speech...");
  try {
    const mp3 = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "onyx",
      input: text,
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    fs.writeFileSync("response.mp3", buffer);
    console.log("Saved response.mp3");
  } catch (err) {
    console.error("TTS failed:", err);
    await logErrorToSupabase("TTS", err.message);
  }
}


// ------------------- START BOT -------------------
client.login(process.env.DISCORDJS_BOT_TOKEN);
