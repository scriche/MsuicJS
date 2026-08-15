// Full-featured Discord Music Bot in JavaScript (discord.js v14)
// Includes: Queue, YouTube search, playlist support, reconnects, slash commands

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Collection, Events, EmbedBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus, StreamType, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { spawn, execFile } = require('child_process');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

const queues = new Map();

const YTDLP_MIN_GAP_MS = 1500;
let ytdlpQueueTail = Promise.resolve();
let lastYtdlpStart = 0;
let backoffUntil = 0;

function noteRateLimited() {
    backoffUntil = Date.now() + 15_000;
}

function waitForYtdlpSlot() {
    const turn = ytdlpQueueTail.then(async () => {
        const earliestStart = Math.max(lastYtdlpStart + YTDLP_MIN_GAP_MS, backoffUntil);
        const wait = earliestStart - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastYtdlpStart = Date.now();
    });
    ytdlpQueueTail = turn.catch(() => {});
    return turn;
}


client.once(Events.ClientReady, () => {
    console.log(`${client.user.tag} has connected to Discord!`);
    client.user.setActivity("Playing Music");
    const commands = [
        new SlashCommandBuilder().setName('play').setDescription('Play a song from YouTube').addStringOption(option => option.setName('query').setDescription('The song name or URL').setRequired(true)),
        new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
        new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
        new SlashCommandBuilder().setName('gaming').setDescription('Play a random gaming music track'),
        new SlashCommandBuilder().setName('fix').setDescription('Fix the bot by restarting it'),
        new SlashCommandBuilder().setName('bb').setDescription('Play a random big bootie track')
    ];
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

async function fetchPlaylistEntries(playlistUrl) {
    await waitForYtdlpSlot();
    return new Promise((resolve, reject) => {
        // execFile with an args array (no shell) avoids passing the URL through
        // a shell, which previously allowed shell metacharacters in a user-supplied
        // query to be interpreted/executed.
        execFile('yt-dlp', [
            '--flat-playlist',
            '--dump-single-json',
            '--js-runtimes', 'node',
            playlistUrl
        ], { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
            if (err) {
                console.error('yt-dlp playlist error:', err, stderr);
                if (/HTTP Error 403|Forbidden/i.test(stderr || '')) noteRateLimited();
                return reject(err);
            }
            try {
                const data = JSON.parse(stdout);
                if (!data.entries || !Array.isArray(data.entries)) {
                    throw new Error('No playlist entries found');
                }
                const playlistTitle = data.title || "Playlist";
                const entries = data.entries.map(entry => ({
                    url: `https://www.youtube.com/watch?v=${entry.id}`,
                    title: entry.title,
                    videoId: entry.id
                }));
                resolve({
                    title: playlistTitle,
                    entries
                });
            } catch (e) {
                console.error('Failed to parse playlist JSON:', e);
                reject(e);
            }
        });
    });
}

// Queues a song after checking voice channel, permissions, and query type
async function queueSong({ interaction, query, guild, member, channel }) {
    if (!member || !member.voice || !member.voice.channel) {
        try {
            await interaction.editReply({ content: "You are not in a voice channel.", flags: MessageFlags.Ephemeral });
        } catch (e) {
            console.error('Failed to reply: not in voice channel', e);
        }
        return;
    }
    const voiceChannel = member.voice.channel;
    // Check bot permissions
    let permissions;
    try {
        permissions = voiceChannel.permissionsFor(guild.members.me);
    } catch (e) {
        console.error('Failed to get permissions:', e);
        await interaction.editReply({ content: "Could not check permissions.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
        await interaction.editReply({ content: "I need permission to join and speak in your voice channel.", flags: MessageFlags.Ephemeral });
        return;
    }

    let queryType = 'search';
    const isYoutubeUrl = /^https?:\/\/(www\.|music\.)?(youtube\.com|youtu\.be)\//i.test(query);
    const isPlaylistUrl = isYoutubeUrl && /\/playlist(\?|$)/i.test(query) && /[?&]list=/i.test(query);
    if (isPlaylistUrl) {
        queryType = 'playlist';
    } else if (isYoutubeUrl) {
        queryType = 'url';
    }

    // Ensure queue is initialized atomically
    if (!queues.has(guild.id)) {
        queues.set(guild.id, { voiceChannel, textChannel: channel, songs: [] });
    }
    const queue = queues.get(guild.id);
    if (!queue) {
        console.error('Queue not found after initialization');
        await interaction.editReply({ content: "Internal error: queue not found." });
        return;
    }
    const wasEmpty = queue.songs.length === 0;

    const embed = new EmbedBuilder()
    .setTitle("Added to queue");

    if (queryType === 'playlist') {
        try {
            await interaction.editReply({ content: `Fetching playlist entries...` });
            const playlist = await fetchPlaylistEntries(query);
            if (!playlist.entries || playlist.entries.length === 0) {
                await interaction.editReply({ content: "No songs found in playlist." });
                return;
            }
            playlist.entries.forEach(entry => {
                queue.songs.push(entry);
            });
            embed
                .setThumbnail(`https://i.ytimg.com/vi/${playlist.entries[0].videoId}/mqdefault.jpg`)
                .setDescription(`**[${playlist.title}](${query})**`)
                .setColor(10038562)
                .setFields({ name: "Songs", value: `${playlist.entries.length}`, inline: true });
            console.log(`Queued playlist: ${playlist.title} in ${guild.name}`);
        } catch (e) {
            console.error('Error fetching playlist:', e);
            await interaction.editReply({ content: "Failed to fetch playlist." });
            return;
        }
    } else {
        // remove the &list== and everything after it for direct video search
        if (queryType === 'url') {
            const urlParts = query.split('&list=');
            if (urlParts.length > 1) {
                query = urlParts[0];
            }
        }
        let song;
        try {
            song = await fetchVideoInfo(query, queryType);
        } catch (e) {
            console.error('Error fetching video info:', e);
            await interaction.editReply({ content: "An error occurred while fetching video info." });
            return;
        }
        queue.songs.push(song);
        embed
            .setDescription(`**[${song.title}](${song.url})**`)
            .setThumbnail(`https://i.ytimg.com/vi/${song.videoId}/mqdefault.jpg`)
            .setColor(10038562);
        console.log(`Queued: ${song.title} in ${guild.name} [${queryType}]`);
    }
    try {
        await interaction.editReply({ content: "", embeds: [embed] });
    } catch (e) {
        console.error('Failed to send embed reply:', e);
    }

    let connection = getVoiceConnection(guild.id);
    if (!connection) {
        connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
        });
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        } catch (e) {
            console.error('Voice connection never became ready:', e);
            try { connection.destroy(); } catch {}
            await interaction.editReply({ content: "Couldn't establish a stable voice connection, please try again." });
            return;
        }
    }

    // Only start playback if nothing is currently playing
    if (wasEmpty) {
        // Check if a player is already playing
        const connection = getVoiceConnection(guild.id);
        let isPlaying = false;
        if (connection && connection.state && connection.state.subscription) {
            const player = connection.state.subscription.player;
            isPlaying = player && player.state.status === AudioPlayerStatus.Playing;
        }
        if (!isPlaying) {
            playNext(guild.id, channel);
        }
    }
}

async function fetchVideoInfo(urlOrQuery) {
    await waitForYtdlpSlot();
    return new Promise((resolve, reject) => {
        // Use yt-dlp to get both info and direct audio URL in one call
        const args = [
            urlOrQuery.startsWith('http') ? urlOrQuery : `ytsearch1:${urlOrQuery}`,
            '-f', 'bestaudio[ext=webm][acodec=opus][abr<=128]/bestaudio',
            '--js-runtimes', 'node',
            '-q',
            '-j' // dump json
        ];
        const ytdlp = spawn('yt-dlp', args);
        let output = '';
        let stderrTail = '';
        ytdlp.stdout.on('data', data => {
            output += data.toString();
        });
        ytdlp.stderr.on('data', data => {
            stderrTail = (stderrTail + data.toString()).slice(-500);
            console.error(`yt-dlp stderr: ${data}`);
        });
        ytdlp.on('error', err => {
            reject(err);
        });
        ytdlp.on('close', code => {
            if (code !== 0) {
                if (/HTTP Error 403|Forbidden/i.test(stderrTail)) noteRateLimited();
                return reject(new Error(`yt-dlp exited with code ${code}`));
            }
            try {
                const info = JSON.parse(output);
                if (!info.url) {
                    return reject(new Error("No audio URL found"));
                }
                resolve({
                    title: info.title,
                    url: info.webpage_url,
                    videoId: info.id || info.video_id || 'unknown',
                    audioUrl: info.url,
                    headers: info.http_headers || null
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function startAudioDownload(videoUrl, maxAttempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await waitForYtdlpSlot();
        try {
            return await new Promise((resolve, reject) => {
                const proc = spawn('yt-dlp', [
                    videoUrl,
                    '-f', 'bestaudio[ext=webm][acodec=opus][abr<=128]/bestaudio',
                    '--js-runtimes', 'node',
                    '--no-playlist',
                    '-q',
                    '-o', '-'
                ], { stdio: ['ignore', 'pipe', 'pipe'] });

                let stderrTail = '';
                let settled = false;

                proc.stderr.on('data', data => {
                    stderrTail = (stderrTail + data.toString()).slice(-500);
                    console.error(`yt-dlp stderr: ${data}`);
                });
                proc.on('error', err => {
                    console.error('yt-dlp process error:', err);
                    if (settled) return;
                    settled = true;
                    clearTimeout(handoffTimer);
                    reject(err);
                });
                const handoffTimer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    resolve(proc);
                }, 3000);
                proc.once('close', (code, signal) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(handoffTimer);
                    if (code !== 0 && signal !== 'SIGKILL') {
                        if (/HTTP Error 403|Forbidden/i.test(stderrTail)) noteRateLimited();
                        reject(new Error(`yt-dlp exited early (code ${code}): ${stderrTail || 'no output'}`));
                    } else {
                        resolve(proc);
                    }
                });
            });
        } catch (e) {
            lastErr = e;
            console.error(`yt-dlp attempt ${attempt}/${maxAttempts} for ${videoUrl} failed: ${e.message}`);
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, attempt * 2000));
            }
        }
    }
    throw lastErr;
}

async function streamAudio(videoUrl) {
    const ytdlp = await startAudioDownload(videoUrl);

    const ffmpeg = spawn('ffmpeg', [
        '-analyzeduration', '0',
        '-loglevel', 'warning',
        '-i', 'pipe:0',
        '-f', 'opus',
        '-map', 'a',
        '-acodec', 'libopus',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '96k',
        'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ffmpeg.stdin.on('error', err => {
        if (err.code !== 'EPIPE' && err.code !== 'EOF') console.error('ffmpeg stdin error:', err);
    });
    ytdlp.stdout.on('error', err => {
        if (err.code !== 'EPIPE' && err.code !== 'EOF') console.error('yt-dlp stdout error:', err);
    });
    ytdlp.stdout.pipe(ffmpeg.stdin);

    ffmpeg.stderr.on('data', data => {
        console.error(`ffmpeg stderr: ${data}`);
    });

    ffmpeg.on('error', err => {
        console.error('Failed to start ffmpeg:', err);
    });

    ffmpeg.on('close', (code, signal) => {
        // SIGKILL means we intentionally killed it (skip/new song) - not an error
        if (code !== 0 && signal !== 'SIGKILL') {
            console.error(`ffmpeg for ${videoUrl} exited unexpectedly (code ${code}, signal ${signal})`);
        }
        if (ytdlp.exitCode === null && ytdlp.signalCode === null && !ytdlp.killed) {
            try { ytdlp.kill('SIGKILL'); } catch (e) { console.error('Error killing yt-dlp after ffmpeg close:', e); }
        }
    });
    ytdlp.on('close', (code, signal) => {
        if (code !== 0 && signal !== 'SIGKILL') {
            console.error(`yt-dlp for ${videoUrl} exited unexpectedly (code ${code}, signal ${signal})`);
        }
    });

    return {
        resource: createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus }),
        process: ffmpeg,
        ytdlpProcess: ytdlp
    };
}
function killLeftoverFfmpeg(connection) {
    if (connection && connection._ffmpegProcess && connection._ffmpegProcess.exitCode === null && connection._ffmpegProcess.signalCode === null && !connection._ffmpegProcess.killed) {
        try { connection._ffmpegProcess.kill('SIGKILL'); } catch (e) { console.error('Error killing ffmpeg process:', e); }
    }
    if (connection && connection._ytdlpProcess && connection._ytdlpProcess.exitCode === null && connection._ytdlpProcess.signalCode === null && !connection._ytdlpProcess.killed) {
        try { connection._ytdlpProcess.kill('SIGKILL'); } catch (e) { console.error('Error killing yt-dlp process:', e); }
    }
}

async function playNext(guildId, channel) {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) return;
    const connection = getVoiceConnection(guildId);
    if (!connection) return;
    // Use or create a persistent player per guild
    if (!connection._player) {
        connection._player = createAudioPlayer();
        connection.subscribe(connection._player);
    }
    const player = connection._player;
    // Prevent race condition: only start next song if player is truly idle
    if (player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Buffering) {
        return;
    }
    // Remove previous listeners to avoid duplicate events
    player.removeAllListeners(AudioPlayerStatus.Idle);
    player.removeAllListeners('error');
    killLeftoverFfmpeg(connection);

    let song = queue.songs.shift();
    // Add error handler to prevent crashes
    player.on('error', (err) => {
        console.error('AudioPlayer error:', err);
        killLeftoverFfmpeg(connection);
        playNext(guildId, channel);
    });
    try {
        const { resource, process, ytdlpProcess } = await streamAudio(song.url);
        connection._ffmpegProcess = process;
        connection._ytdlpProcess = ytdlpProcess;
        player.play(resource);
        if (channel && channel.guild) {
            console.log(`Playing: ${song.title} in ${channel.guild.name}`);
        } else {
            console.log(`Playing: ${song.title}`);
        }
        entersState(player, AudioPlayerStatus.Playing, 20_000).catch(() => {
            if (connection._ffmpegProcess !== process) return; // a later song already took over
            console.error(`"${song.title}" never started playing (stuck buffering) - skipping it`);
            player.removeAllListeners(AudioPlayerStatus.Idle);
            killLeftoverFfmpeg(connection);
            try { player.stop(true); } catch (e) { console.error('Error stopping stuck player:', e); }
            playNext(guildId, channel);
        });
    } catch (err) {
        console.error('Error playing stream:', err);
        return playNext(guildId, channel);
    }
    player.on(AudioPlayerStatus.Idle, () => {
        killLeftoverFfmpeg(connection);
        playNext(guildId, channel);
    });
}

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, guild, member, channel } = interaction;
    try {
        if (commandName === 'play') {
            const query = options.getString('query');
            await interaction.reply(`Searching for **${query}**...`);
            await queueSong({ interaction, query, guild, member, channel });
        } else if (commandName === 'skip') {
            const queue = queues.get(guild.id);
            const connection = getVoiceConnection(guild.id);
            let isPlaying = false;
            let player;
            if (connection && connection.state && connection.state.subscription) {
                player = connection.state.subscription.player;
                isPlaying = player && (player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Buffering);
            }
            if (!queue || queue.songs.length === 0 || !isPlaying) {
                if (player) {
                    player.removeAllListeners(AudioPlayerStatus.Idle);
                    player.removeAllListeners('error');
                    try { player.stop(true); } catch (e) { console.error('Error stopping player:', e); }
                }
                killLeftoverFfmpeg(connection);
                await interaction.reply({ content: "Nothing left to skip. Stopped playback.", flags: MessageFlags.Ephemeral });
                return;
            }
            if (player) {
                player.removeAllListeners(AudioPlayerStatus.Idle);
                player.removeAllListeners('error');
                try { player.stop(true); } catch (e) { console.error('Error stopping player:', e); }
                killLeftoverFfmpeg(connection);
                // Only play next if there are songs left in the queue
                const hasNext = queue.songs.length > 0;
                if (hasNext) {
                    if (player.state.status === AudioPlayerStatus.Idle) {
                        playNext(guild.id, channel);
                    } else {
                        player.once(AudioPlayerStatus.Idle, () => {
                            playNext(guild.id, channel);
                        });
                    }
                }
            }
            await interaction.reply({ content: "Skipped the current song.", flags: MessageFlags.Ephemeral });
        } else if (commandName === 'stop') {
            const connection = getVoiceConnection(guild.id);
            if (connection) {
                killLeftoverFfmpeg(connection);
                try { connection.destroy(); } catch (e) { console.error('Error destroying connection:', e); }
            }
            queues.delete(guild.id);
            await interaction.reply({ content: "Stopped playing and cleared the queue.", flags: MessageFlags.Ephemeral });
        } else if (commandName === 'gaming') {
            const playlisturl = "https://www.youtube.com/playlist?list=PL_VhV5m_X3BK-j1rqyOG5j7FraqSEIxVw";
            await interaction.reply("**It's Gaming Time**...");
            try {
                const playlist = await fetchPlaylistEntries(playlisturl);
                if (!playlist.entries || playlist.entries.length === 0) {
                    await interaction.editReply({ content: "No songs found in gaming playlist." });
                    return;
                }
                const randomEntry = playlist.entries[Math.floor(Math.random() * playlist.entries.length)];
                await queueSong({ interaction, query: randomEntry.url, guild, member, channel });
            } catch (e) {
                console.error('Gaming playlist error:', e);
                await interaction.editReply({ content: "Video unavailable." });
            }
        } else if (commandName === 'bb') {
            const playlisturl = "https://youtube.com/playlist?list=PLT1Q6ojTeAE8Zr_tlQkm6E3NLvP1sWmT_&si=O43a9mfBuj6b8vze";
            await interaction.reply("**Emir loves big bootie**...");
            try {
                const playlist = await fetchPlaylistEntries(playlisturl);
                if (!playlist.entries || playlist.entries.length === 0) {
                    await interaction.editReply({ content: "No songs found in big bootie playlist." });
                    return;
                }
                const randomEntry = playlist.entries[Math.floor(Math.random() * playlist.entries.length)];
                await queueSong({ interaction, query: randomEntry.url, guild, member, channel });
            } catch (e) {
                console.error('Big Bootie playlist error:', e);
                await interaction.editReply({ content: "Video unavailable." });
            }
        } else if (commandName === 'fix') {
            // restart the container by stopping the process
            await interaction.reply("Restarting the bot...");
            process.exit(0);
        }
    } catch (e) {
        console.error('Interaction handler error:', e);
        try {
            await interaction.reply({ content: "An error occurred while processing your command.", flags: MessageFlags.Ephemeral });
        } catch {}
    }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    try {
        if (oldState.member?.id === client.user.id && !newState.channelId) {
            console.log(`Bot was disconnected in ${oldState.guild.name}`);
            const connection = getVoiceConnection(oldState.guild.id);
            if (connection) connection.destroy();
        }
        const channel = oldState.channel;
        if (!channel) return;
        const botMember = channel.guild.members.me;
        if (!botMember?.voice.channelId) return;
        if (channel.id === botMember.voice.channelId) {
            const nonBotMembers = channel.members.filter(m => !m.user.bot);
            if (nonBotMembers.size === 0) {
            console.log(`Bot is alone in ${channel.name}, disconnecting...`);
            const connection = getVoiceConnection(channel.guild.id);
            if (connection) connection.destroy();
            }
        }
    } catch (e) {
        console.error('VoiceStateUpdate error:', e);
    }
});

process.on('uncaughtException', err => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', reason => {
    console.error('Unhandled Rejection:', reason);
    process.exit(1);
});

client.on('shardDisconnect', (_, shardId) => {
    console.warn(`Shard ${shardId} disconnected.`);
});

client.login(process.env.DISCORD_TOKEN);