// Full-featured Discord Music Bot in JavaScript (discord.js v14)
// Includes: Queue, YouTube search, playlist support, reconnects, slash commands

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Collection, Events, EmbedBuilder, InteractionResponseFlags, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { spawn, exec } = require('child_process');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

const queues = new Map();

client.once(Events.ClientReady, () => {
    console.log(`${client.user.tag} has connected to Discord!`);
    client.user.setActivity("Music");
});

async function fetchPlaylistEntries(playlistUrl) {
    return new Promise((resolve, reject) => {
        exec(`yt-dlp --flat-playlist --dump-single-json "${playlistUrl}"`, (err, stdout, stderr) => {
            if (err) {
                console.error('yt-dlp playlist error:', err, stderr);
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

    // Categorise query
    let queryType = 'search';
    if (query.toLowerCase().includes('playlist')) {
        queryType = 'playlist';
    } else if (query.includes('youtube.com') || query.includes('youtu.be')) {
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
            // Handle error and inform user gracefully
            switch (e.message) {
                case 'No audio URL found':
                    await interaction.editReply({ content: "Could not extract audio from the provided URL." });
                    break;
                case 'Video not found':
                    await interaction.editReply({ content: "The requested video could not be found." });
                    break;
                case 'Private video':
                    await interaction.editReply({ content: "The requested video is private." });
                    break;
                case 'This video is age-restricted':
                    await interaction.editReply({ content: "The requested video is age-restricted and cannot be played." });
                    break;
                case 'Video unavailable':
                    await interaction.editReply({ content: "The requested video is unavailable." });
                    break;
                default:
                    await interaction.editReply({ content: "An error occurred while fetching video info." });
            }
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

    const { DAVESession } = require('@snazzah/davey');

    // join the voice channel normally first
    let connection = getVoiceConnection(guild.id);
    if (!connection) {
        connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
        });
    }

    // create DAVE session and bind it to the connection
    let dave = queues.get(`${guild.id}-dave`);
    if (!dave) {
        dave = new DAVESession(
            1,                 // protocol version
            client.user.id,    // bot user ID (string)
            voiceChannel.id,   // voice channel ID (string)
            null               // let it generate a key pair
        );
        queues.set(`${guild.id}-dave`, dave);

        // tell the voice connection to use DAVE
        connection.configureNetworking(dave);
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
    return new Promise((resolve, reject) => {
        // Use yt-dlp to get both info and direct audio URL in one call
        const args = [
            urlOrQuery.startsWith('http') ? urlOrQuery : `ytsearch1:${urlOrQuery}`,
            '-f', 'bestaudio[ext=webm][acodec=opus][abr<=128]/bestaudio',
            '-q',
            '-j' // dump json
        ];
        const ytdlp = spawn('yt-dlp', args);
        let output = '';
        ytdlp.stdout.on('data', data => {
            output += data.toString();
        });
        ytdlp.stderr.on('data', data => {
            console.error(`yt-dlp stderr: ${data}`);
        });
        ytdlp.on('close', code => {
            if (code !== 0) {
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
                    audioUrl: info.url
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function streamAudio(url) {
    const ffmpeg = spawn('ffmpeg', [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url,
        '-analyzeduration', '0',
        '-loglevel', '0',
        '-f', 'webm',
        '-map', 'a',
        '-acodec', 'libopus',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '96k',
        'pipe:1'
    ]);

    ffmpeg.stderr.on('data', data => {
        console.error(`ffmpeg stderr: ${data}`);
    });

    ffmpeg.on('error', err => {
        console.error('Failed to start ffmpeg:', err);
    });

    return createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.WebmOpus
    });
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

    // Get the next song
    const song = queue.songs.shift();
    // Add error handler to prevent crashes
    player.on('error', (err) => {
        console.error('AudioPlayer error:', err);
        playNext(guildId, channel);
    });
    try {
        const resource = await streamAudio(song.audioUrl || song.url);
        player.play(resource);
        if (channel && channel.guild) {
            console.log(`Playing: ${song.title} in ${channel.guild.name}`);
        } else {
            console.log(`Playing: ${song.title}`);
        }
    } catch (err) {
        console.error('Error playing stream:', err);
        return playNext(guildId, channel);
    }
    player.on(AudioPlayerStatus.Idle, () => playNext(guildId, channel));
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
                isPlaying = player && player.state.status === AudioPlayerStatus.Playing;
            }
            if (!queue || queue.songs.length === 0 || !isPlaying) {
                if (player) {
                    try { player.stop(true); } catch (e) { console.error('Error stopping player:', e); }
                }
                await interaction.reply({ content: "Nothing left to skip. Stopped playback.", flags: MessageFlags.Ephemeral });
                return;
            }
            if (player) {
                player.removeAllListeners(AudioPlayerStatus.Idle);
                try { player.stop(true); } catch (e) { console.error('Error stopping player:', e); }
                // Only play next if there are songs left in the queue
                const queue = queues.get(guild.id);
                const hasNext = queue && queue.songs.length > 0;
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
                await interaction.editReply({ content: "Failed to load gaming playlist." });
            }
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
