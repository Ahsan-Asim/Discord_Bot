require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const wav = require('wav');
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Track users currently being recorded
const recordingUsers = new Map();

// --- Bot ready event ---
client.once('ready', async () => {
  console.log("Bot is starting...");
  console.log(`🤖 Logged in as ${client.user.tag}`);
  client.user.setActivity('souls burn...', { type: 'PLAYING' });

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const channel = guild.channels.cache.get(process.env.VOICE_CHANNEL_ID);

    if (!channel) return console.error("❌ Voice channel not found!");

    joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
    });

    console.log("✅ Joined voice channel successfully!");
  } catch (err) {
    console.error("❌ Failed to join voice channel:", err);
  }
});

// GPT text reply helper
async function getGPTReply(messageText) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are Hellgate, a dark commanding AI agent bot and you have to give strong replies" },
      { role: "user", content: messageText }
    ]
  });
  return response.choices[0].message.content;
}

// Text message handler
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  try {
    const gptResponse = await getGPTReply(message.content);
    message.reply(gptResponse);
  } catch (error) {
    console.error("Error fetching GPT reply:", error);
    message.reply("⚠️ I encountered an error trying to respond.");
  }
});

// Voice listener — record, transcribe, reply & TTS
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.channelId || newState.member.user.bot) return;
  if (newState.channelId !== process.env.VOICE_CHANNEL_ID) return;

  const userId = newState.member.user.id;
  if (recordingUsers.has(userId)) return;
  recordingUsers.set(userId, true);

  console.log(`🎙️ ${newState.member.user.username} joined voice channel`);

  const connection = getVoiceConnection(newState.guild.id);
  if (!connection) return console.error('❌ Bot not connected to voice channel');

  const receiver = connection.receiver;

  receiver.speaking.on('start', (speakingUserId) => {
    if (speakingUserId !== userId) return;

    const user = newState.guild.members.cache.get(userId);
    if (!user) return;

    console.log(`🎧 Listening to ${user.user.username}...`);

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });

    const chunks = [];
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });

    decoder.on('data', (chunk) => chunks.push(chunk));
    decoder.on('error', (err) => console.error('❌ Decoder error (ignored):', err));

    audioStream.pipe(decoder);

    audioStream.on('end', async () => {
      if (chunks.length === 0) {
        console.log(`⚠️ No audio captured from ${user.user.username}`);
        recordingUsers.delete(userId);
        return;
      }

      // Save WAV
      const wavPath = path.join(__dirname, `${userId}.wav`);
      const wavWriter = new wav.FileWriter(wavPath, { channels: 1, sampleRate: 48000, bitDepth: 16 });
      for (const chunk of chunks) wavWriter.write(chunk);
      wavWriter.end();

      wavWriter.on('finish', async () => {
        console.log(`🎵 Saved WAV audio from ${user.user.username} at ${wavPath}`);

        // --- Step 1: Transcribe using Whisper ---
        try {
          const transcriptionFile = fs.createReadStream(wavPath);
          const transcription = await openai.audio.transcriptions.create({
            file: transcriptionFile,
            model: "whisper-1",
          });

          const userText = transcription.text;
          console.log(`📝 Transcription: ${userText}`);

          // --- Step 2: GPT reply ---
          const gptReply = await getGPTReply(userText);
          console.log(`💬 GPT reply: ${gptReply}`);

          // --- Step 3: TTS (voice reply) ---
          const ttsPath = path.join(__dirname, `${userId}_reply.wav`);
          const ttsResponse = await openai.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice: "alloy",
            input: gptReply,
          });

          const buffer = Buffer.from(await ttsResponse.arrayBuffer());
          fs.writeFileSync(ttsPath, buffer);
          console.log(`🎵 Saved TTS reply at: ${ttsPath}`);

          // --- Step 4: Play TTS in voice channel ---
          const player = createAudioPlayer();
          const resource = createAudioResource(ttsPath);
          player.play(resource);
          connection.subscribe(player);

          player.on(AudioPlayerStatus.Idle, () => {
            console.log("✅ Finished playing TTS reply.");
          });

        } catch (err) {
          console.error("❌ Error during transcription/GPT/TTS:", err);
        } finally {
          recordingUsers.delete(userId);
        }
      });
    });
  });
});

client.login(process.env.DISCORDJS_BOT_TOKEN);
