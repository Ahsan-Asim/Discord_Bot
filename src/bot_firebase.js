import dotenv from "dotenv";
import fs from "fs";
import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} from "@discordjs/voice";
import { Client, GatewayIntentBits, Events } from "discord.js";
import prism from "prism-media";
import wav from "wav";
import OpenAI from "openai";
import { db } from "./firebase.js";
import { ref, push, set, update } from "firebase/database";

dotenv.config();

// ------------------- Firebase Save -------------------
async function saveScheduleToFirebase(username, userMessages, botResponses, scheduleText) {
  try {
    const userRef = ref(db, `users/${username}`);

    // Update main profile fields
    await update(userRef, {
      username,
      schedulesMessage: scheduleText,
      responding: botResponses[botResponses.length - 1],
      memory: "Learning Firebase",
    });

    // Save history under schedules
    const scheduleRef = ref(db, `users/${username}/schedules`);
    const newSchedule = push(scheduleRef);

    await set(newSchedule, {
      messages: userMessages.join(" | "),
      responses: botResponses.join(" | "),
      createdAt: Date.now(),
    });

    console.log("✅ Saved to Firebase");
  } catch (err) {
    console.error("Firebase error:", err);
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
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) return console.error("Guild not found.");

  const voiceChannel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID).catch(() => null);
  if (!voiceChannel || voiceChannel.type !== 2) return console.error("Voice channel not found.");

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

  // Attach listeners to existing members
  voiceChannel.members.forEach((member) => {
    if (!member.user.bot) attachVoiceListener(connection, member.id, member);
  });
});

// ------------------- VOICE LISTENER -------------------
const isRecording = {};

function attachVoiceListener(connection, userId, member) {
  const receiver = connection.receiver;
  console.log(`🎧 Listening to ${member.user.username}...`);

  const handleSpeaking = async (id) => {
    if (id !== userId || isRecording[userId]) return;
    isRecording[userId] = true;

    console.log(`🎙️ ${member.user.username} started speaking...`);

    const opusStream = receiver.subscribe(id, { end: { behavior: EndBehaviorType.Manual }, mode: "opus" });
    const wavPath = `./temp_${userId}_${Date.now()}.wav`;
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    const wavWriter = new wav.FileWriter(wavPath, { sampleRate: 48000, channels: 1 });

    opusStream.pipe(decoder).pipe(wavWriter);

    let silenceTimer;
    opusStream.on("data", () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => opusStream.emit("end"), 1500);
    });

    const finishWriting = new Promise((resolve, reject) => {
      wavWriter.on("finish", resolve);
      wavWriter.on("error", reject);
    });

    opusStream.on("end", () => {
      opusStream.unpipe();
      decoder.end();
      wavWriter.end();
    });

    await finishWriting;
    console.log(`WAV saved: ${wavPath}`);

    const transcription = await transcribeAudio(wavPath);
    console.log(`${member.user.username} says: "${transcription}"`);
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    const userMessages = [];
    const botResponses = [];

    // ------------------- Voice schedule registration -------------------
    if (transcription.toLowerCase().includes("register") || transcription.toLowerCase().includes("schedule")) {
      userMessages.push(transcription);
      const confirmText = "You want to register your schedule. Do you want to continue? Reply with YES to confirm.";
      botResponses.push(confirmText);

      const confirmPath = `./response_${userId}.mp3`;
      await textToSpeech(confirmText, confirmPath);
      await playAudioInVC(connection, confirmPath);

      const replyTranscription = await waitForNextSpeech(connection, userId);
      console.log(`Confirmation received: ${replyTranscription}`);
      userMessages.push(replyTranscription);

      if (replyTranscription.toLowerCase().includes("yes")) {
        const askDetails = "Please provide your schedule details in one message:";
        botResponses.push(askDetails);

        const detailsPath = `./response_${userId}.mp3`;
        await textToSpeech(askDetails, detailsPath);
        await playAudioInVC(connection, detailsPath);

        const scheduleDetails = await waitForNextSpeech(connection, userId);
        console.log(`Schedule details: ${scheduleDetails}`);
        userMessages.push(scheduleDetails);
        botResponses.push("Your schedule has been registered!");

        // ✅ Save to Firebase
        await saveScheduleToFirebase(
          member.user.username,
          userMessages,
          botResponses,
          scheduleDetails
        );

        const confirmationReply = "Your schedule has been registered!";
        const confirmReplyPath = `./response_${userId}.mp3`;
        await textToSpeech(confirmationReply, confirmReplyPath);
        await playAudioInVC(connection, confirmReplyPath);

      } else {
        botResponses.push("Registration cancelled.");

        const cancelText = "Registration cancelled.";
        const cancelPath = `./response_${userId}.mp3`;
        await textToSpeech(cancelText, cancelPath);
        await playAudioInVC(connection, cancelPath);

        console.log("User declined schedule registration. Not saving to Firebase.");
      }

      isRecording[userId] = false;
      attachListener();
      return;
    }

    // ------------------- Normal GPT voice reply -------------------
    try {
      const gptResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are Hellgate, the dark, commanding voice of The Underground Market." },
          { role: "user", content: transcription },
        ],
      });

      const replyText = gptResp.choices[0].message.content.trim();
      console.log(`GPT says: "${replyText}"`);

      const replyPath = `./response_${userId}.mp3`;
      await textToSpeech(replyText, replyPath);
      await playAudioInVC(connection, replyPath);

    } catch (err) {
      console.error("Error generating GPT reply:", err);
    }

    isRecording[userId] = false;
    attachListener();
  };

  const attachListener = () => receiver.speaking.once("start", handleSpeaking);
  attachListener();
}

// ------------------- Helper to wait for next speech from same user -------------------
async function waitForNextSpeech(connection, userId) {
  return new Promise((resolve) => {
    const receiver = connection.receiver;
    const handleSpeech = async (id) => {
      if (id !== userId) return;

      const opusStream = receiver.subscribe(id, { end: { behavior: EndBehaviorType.Manual }, mode: "opus" });
      const wavPath = `./temp_${userId}_${Date.now()}.wav`;
      const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
      const wavWriter = new wav.FileWriter(wavPath, { sampleRate: 48000, channels: 1 });
      opusStream.pipe(decoder).pipe(wavWriter);

      let silenceTimer;
      opusStream.on("data", () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => opusStream.emit("end"), 1500);
      });

      const finishWriting = new Promise((res) => wavWriter.on("finish", res));
      opusStream.on("end", () => {
        opusStream.unpipe();
        decoder.end();
        wavWriter.end();
      });

      await finishWriting;
      const text = await transcribeAudio(wavPath);
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      resolve(text);
    };

    receiver.speaking.once("start", handleSpeech);
  });
}

// ------------------- TRANSCRIPTION -------------------
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
    return "";
  }
}

// ------------------- TEXT TO SPEECH -------------------
async function textToSpeech(text, filePath) {
  console.log("🔊 Converting text to speech...");
  try {
    const mp3 = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "onyx",
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    console.log(`Saved TTS to ${filePath}`);
  } catch (err) {
    console.error("TTS failed:", err);
  }
}

// ------------------- PLAY AUDIO IN VC -------------------
async function playAudioInVC(connection, filePath) {
  return new Promise((resolve, reject) => {
    try {
      const player = createAudioPlayer();
      const resource = createAudioResource(fs.createReadStream(filePath));

      connection.subscribe(player);
      player.play(resource);

      console.log("Playing response in voice channel...");
      player.on(AudioPlayerStatus.Playing, () => console.log("🎙️ Bot is speaking..."));

      player.on(AudioPlayerStatus.Idle, () => {
        console.log("Audio finished.");
        player.stop();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        resolve();
      });

      player.on("error", (err) => {
        console.error("AudioPlayer error:", err);
        reject(err);
      });
    } catch (err) {
      console.error("Error playing audio in voice channel:", err);
      reject(err);
    }
  });
}

// ------------------- VOICE STATE UPDATE -------------------
client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.member.user.bot) return;

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

  try {
    // Chat schedule registration
    if (userText.includes("register") && userText.includes("schedule")) {

      await message.channel.send(
        "You want to register your schedule. Reply YES to confirm."
      );

      const filter = (m) => m.author.id === message.author.id;
      const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000 });
      const reply = collected.first().content.trim().toUpperCase();

      const userMessages = [];
      const botResponses = [];
      botResponses.push("Confirmation requested");

      if (reply === "YES") {

        await message.channel.send("Please provide your schedule details in one message:");

        const scheduleCollected = await message.channel.awaitMessages({ filter, max: 1, time: 60000 });
        const scheduleText = scheduleCollected.first().content.trim();

        userMessages.push(scheduleText);
        botResponses.push("Your schedule has been registered!");

        // ✅ Save to Firebase
        await saveScheduleToFirebase(
          message.author.username,
          userMessages,
          botResponses,
          scheduleText
        );

        await message.channel.send("✅ Schedule saved successfully!");

      } else {
        await message.channel.send("Registration cancelled.");
      }

      return;
    }

    // GPT response for text chat
    const messages = [
      { role: "system", content: "You are Hellgate, the dark, commanding voice of The Underground Market." },
      { role: "user", content: message.content },
    ];

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const replyText = resp.choices[0].message.content.trim();
    await message.channel.send(replyText);

  } catch (err) {
    console.error("Error processing text message:", err);
    await message.channel.send("Something went wrong while processing your request.");
  }
});

// ------------------- START BOT -------------------
client.login(process.env.DISCORDJS_BOT_TOKEN);