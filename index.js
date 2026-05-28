require('dotenv').config();
const express = require('express');
const { verifyKeyMiddleware, InteractionType, InteractionResponseType } = require('discord-interactions');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const CLICKUP_DONE_STATUS = process.env.CLICKUP_DONE_STATUS || 'done';
const CLICKUP_IN_REVIEW_STATUS = process.env.CLICKUP_IN_REVIEW_STATUS || 'in review';

// In-memory store for threadData keyed by messageId
const draftStore = new Map();

// In-memory store for clip data keyed by messageId
const clipStore = new Map();

async function updateClickUpStatus(taskId, status) {
  await axios.put(
    `https://api.clickup.com/api/v2/task/${taskId}`,
    { status },
    {
      headers: {
        Authorization: CLICKUP_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function getClickUpTask(taskId) {
  const res = await axios.get(
    `https://api.clickup.com/api/v2/task/${taskId}`,
    { headers: { Authorization: CLICKUP_API_KEY } }
  );
  return res.data;
}

async function editInteractionMessage(token, content, embeds = [], components = []) {
  await axios.patch(
    `https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`,
    { content, embeds, components },
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// ─── Express server ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

/**
 * POST /send-draft
 * Body: { channelId, fileName, draft, tweetId, driveFileId, threadData }
 */
app.post('/send-draft', async (req, res) => {
  const { channelId, fileName, draft, tweetId, driveFileId, threadData } = req.body;

  if (!channelId || !draft) {
    return res.status(400).json({ error: 'Missing channelId or draft' });
  }

  try {
    const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const truncated = draft.length > 3800
      ? draft.substring(0, 3800) + '\n\n...(truncated)'
      : draft;

    const embed = new EmbedBuilder()
      .setTitle('🎬 New Twitter Draft Ready for Review')
      .setColor(0x3498DB)
      .setDescription(`**📁 Source file:** \`${fileName || 'Unknown'}\`\n\n---\n\n${truncated}`)
      .setFooter({ text: 'Click Approve to post or Reject to discard' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_draft::${tweetId || ''}::${driveFileId || ''}`)
        .setLabel('✅ APPROVE')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_draft::${tweetId || ''}`)
        .setLabel('❌ REJECT')
        .setStyle(ButtonStyle.Danger)
    );

    const message = await channel.send({
      content: `<@366635705964953601> 📋 **New long-form Twitter draft generated from video upload.**`,
      embeds: [embed],
      components: [row],
    });

    // Store threadData keyed by messageId
    if (threadData) {
      draftStore.set(message.id, {
        threadData,
        driveFileId: driveFileId || '',
        fileName: fileName || '',
        storedAt: Date.now()
      });
      console.log(`[store] Stored threadData for message ${message.id}`);
    }

    res.json({ success: true, messageId: message.id });
  } catch (err) {
    console.error('[draft] Error sending draft:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /send-clips
 * Body: { channelId, clips: [{index, url, duration, score, thumbnail}], driveFileId, hookText }
 * Sends each clip as a separate Discord message with Approve/Reject buttons
 */
app.post('/send-clips', async (req, res) => {
  const { channelId, clips, driveFileId, hookText } = req.body;

  if (!channelId || !clips || clips.length === 0) {
    return res.status(400).json({ error: 'Missing channelId or clips' });
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    // Send header message
    await channel.send({
      content: `<@366635705964953601> 🎬 **${clips.length} OpusClip${clips.length > 1 ? 's' : ''} ready for review — approve to quote tweet the thread**`,
    });

    const messageIds = [];

    for (const clip of clips) {
      const durationStr = clip.duration ? `${Math.floor(clip.duration)}s` : 'unknown duration';
      const scoreStr = clip.score ? ` · Score: ${clip.score}` : '';

      const embed = new EmbedBuilder()
        .setTitle(`🎬 Clip ${clip.index} — ${durationStr}${scoreStr}`)
        .setColor(0x1DA1F2)
        .setDescription(`**Preview:** ${clip.url}`)
        .setFooter({ text: 'Approve to quote tweet the thread • Reject to skip this clip' })
        .setTimestamp();

      if (clip.thumbnail) {
        embed.setImage(clip.thumbnail);
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_clip::${clip.index}`)
          .setLabel('✅ Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_clip::${clip.index}`)
          .setLabel('❌ Reject')
          .setStyle(ButtonStyle.Danger)
      );

      const message = await channel.send({
        embeds: [embed],
        components: [row],
      });

      // Store clip data keyed by messageId
      clipStore.set(message.id, {
        clipIndex: clip.index,
        clipUrl: clip.url,
        duration: clip.duration,
        driveFileId: driveFileId || '',
        hookText: hookText || '',
        storedAt: Date.now(),
      });

      console.log(`[clips] Sent clip ${clip.index} as message ${message.id}`);
      messageIds.push(message.id);

      // Small delay between messages
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ success: true, messageIds });
  } catch (err) {
    console.error('[clips] Error sending clips:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`[express] Server running on port ${PORT}`));

// ─── Discord client ───────────────────────────────────────────────────────────
const { Client, GatewayIntentBits, Partials, ChannelType, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
  ],
});

// ─── Button interaction handler ───────────────────────────────────────────────
app.post('/interactions', verifyKeyMiddleware(DISCORD_PUBLIC_KEY), async (req, res) => {
  const interaction = req.body;

  if (interaction.type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  // ── MODAL SUBMIT ────────────────────────────────────────────────────────────
  if (interaction.type === 5) {
    const customId = interaction.data.custom_id;

    if (customId.startsWith('reject_feedback::')) {
      const [, driveFileId, channelId, messageId] = customId.split('::');
      const feedback = interaction.data.components[0].components[0].value;
      const originalDraft = interaction.data.components[1]?.components[0]?.value || '';
      const username = interaction.member?.user?.username || interaction.user?.username;
      const token = interaction.token;

      res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

      await editInteractionMessage(
        token,
        `🔄 **Regenerating draft with feedback from ${username}...**\n\n> "${feedback}"`,
        [],
        []
      ).catch(err => console.error('Failed to update message after modal submit:', err.message));

      const N8N_APPROVAL_WEBHOOK = process.env.N8N_APPROVAL_WEBHOOK;
      if (N8N_APPROVAL_WEBHOOK) {
        await axios.post(N8N_APPROVAL_WEBHOOK, {
          action: 'revise',
          driveFileId,
          feedback,
          originalDraft,
          rejectedBy: username,
          channelId,
          messageId,
          timestamp: new Date().toISOString(),
        }).catch(err => console.error('Failed to forward revision to n8n:', err.message));
      }

      return;
    }
  }

  // ── MESSAGE COMPONENT (buttons) ─────────────────────────────────────────────
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id;
    const token = interaction.token;
    const messageId = interaction.message?.id;

    // ── Clip approve/reject buttons ───────────────────────────────────────────
    if (customId.startsWith('approve_clip') || customId.startsWith('reject_clip')) {
      const [action, clipIndex] = customId.split('::');
      const username = interaction.member?.user?.username || interaction.user?.username;
      const stored = clipStore.get(messageId);

      res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

      if (action === 'approve_clip') {
        const N8N_CLIP_WEBHOOK = process.env.N8N_CLIP_WEBHOOK;
        if (N8N_CLIP_WEBHOOK && stored) {
          await axios.post(N8N_CLIP_WEBHOOK, {
            action: 'approve',
            clipIndex: stored.clipIndex,
            clipUrl: stored.clipUrl,
            duration: stored.duration,
            driveFileId: stored.driveFileId,
            hookText: stored.hookText,
            approvedBy: username,
            timestamp: new Date().toISOString(),
          }).catch(err => console.error('[clips] Failed to forward approval to n8n:', err.message));
        }

        clipStore.delete(messageId);

        await editInteractionMessage(
          token,
          `✅ **Clip ${clipIndex} approved!** Will be posted as a quote tweet after the thread goes live.\n\n_Approved by ${username}_`,
          [],
          []
        ).catch(err => console.error('[clips] Failed to update message:', err.message));

      } else if (action === 'reject_clip') {
        clipStore.delete(messageId);

        await editInteractionMessage(
          token,
          `❌ **Clip ${clipIndex} rejected.**\n\n_Rejected by ${username}_`,
          [],
          []
        ).catch(err => console.error('[clips] Failed to update message:', err.message));
      }

      return;
    }

    // ── Twitter draft approval buttons ────────────────────────────────────────
    if (customId.startsWith('approve_draft') || customId.startsWith('reject_draft')) {
      const N8N_APPROVAL_WEBHOOK = process.env.N8N_APPROVAL_WEBHOOK;
      const [action, tweetId, driveFileId] = customId.split('::');
      const username = interaction.member?.user?.username || interaction.user?.username;

      if (action === 'approve_draft') {
        res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

        const draft = interaction.message.embeds?.[0]?.description?.split('---\n\n')[1] || '';

        // Retrieve stored threadData
        const stored = draftStore.get(messageId);
        const threadData = stored ? stored.threadData : null;
        const storedDriveFileId = stored ? stored.driveFileId : driveFileId;

        console.log(`[approve] messageId: ${messageId}, hasThreadData: ${!!threadData}`);

        if (N8N_APPROVAL_WEBHOOK) {
          await axios.post(N8N_APPROVAL_WEBHOOK, {
            action: 'approve',
            tweetId,
            driveFileId: storedDriveFileId,
            draft,
            threadData,
            approvedBy: username,
            timestamp: new Date().toISOString(),
          }).catch(err => console.error('Failed to forward approval:', err.message));
        }

        // Clean up store
        draftStore.delete(messageId);

        await editInteractionMessage(
          token,
          `✅ **Post queued in Hypefury!** It will go live on @MaddenAcademy_ according to the schedule.\n\n_Approved by ${username}_`,
          [],
          []
        ).catch(err => console.error('Failed to update message after approve:', err.message));

      } else if (action === 'reject_draft') {
        const originalDraft = interaction.message.embeds?.[0]?.description?.split('---\n\n')[1] || '';
        const channelId = interaction.channel_id;

        return res.json({
          type: 9,
          data: {
            custom_id: `reject_feedback::${driveFileId}::${channelId}::${messageId}`,
            title: 'Revise This Draft',
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: 'feedback',
                    label: 'What needs to be added or revised?',
                    style: 2,
                    placeholder: 'e.g. "Add a title", "Revise section 3", "Make it shorter"',
                    required: true,
                    max_length: 1000,
                  }
                ]
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: 'original_draft',
                    label: 'Original Draft (do not edit)',
                    style: 2,
                    value: originalDraft.substring(0, 4000),
                    required: false,
                  }
                ]
              }
            ]
          }
        });
      }

      return;
    }

    // ── Existing ClickUp logic ─────────────────────────────────────────────────
    const [action, taskId] = customId.split('_TASK_');
    if (!taskId) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '❌ Invalid button action.', flags: 64 }
      });
    }

    res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    try {
      const task = await getClickUpTask(taskId);
      const taskName = task.name;
      if (action === 'done') {
        await updateClickUpStatus(taskId, CLICKUP_DONE_STATUS);
        await editInteractionMessage(token, `✅ **Marked as Done:** ${taskName}\n_ClickUp has been updated._`);
      } else if (action === 'review') {
        await updateClickUpStatus(taskId, CLICKUP_IN_REVIEW_STATUS);
        await editInteractionMessage(token, `🔍 **Sent for Review:** ${taskName}\n_ClickUp has been updated._`);
      }
    } catch (err) {
      console.error('Error handling interaction:', err?.response?.data || err.message);
      await editInteractionMessage(token, `❌ Failed to update task. Please check ClickUp manually.`).catch(() => {});
    }
    return;
  }

  return res.status(400).json({ error: 'Unknown interaction type' });
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[proxy] Logged in as ${readyClient.user.tag}`);
});

client.on(Events.Error, (err) => {
  console.error('[proxy] Discord client error:', err.message);
});

client.login(process.env.DISCORD_BOT_TOKEN);
