require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
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

    // Store draft text + threadData keyed by messageId (needed later at approve-modal-submit time,
    // since modal submissions don't have access to the original message's embed)
    draftStore.set(message.id, {
      threadData: threadData || null,
      draft: draft || '',
      driveFileId: driveFileId || '',
      fileName: fileName || '',
      storedAt: Date.now()
    });
    console.log(`[store] Stored draft${threadData ? ' + threadData' : ''} for message ${message.id}`);

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

// ============================================================
// TRAIN WITH MANU — Discord Coaching Channel Creator
// ============================================================

function verifyWebhookSecret(req) {
  const incoming = req.headers['x-twm-secret'] || '';
  const expected = process.env.TWM_WEBHOOK_SECRET || '';
  if (!expected) return true;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(incoming),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

app.post('/create-coaching-channel', async (req, res) => {
  if (!verifyWebhookSecret(req)) {
    console.warn('[TWM] Rejected request — bad webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { user_id, first_name, last_name, email, order_id } = req.body;

  if (!user_id || !first_name) {
    return res.status(400).json({ error: 'Missing user_id or first_name' });
  }

  const guildId    = process.env.COACHING_GUILD_ID;
  const categoryId = process.env.COACHING_CATEGORY_ID;
  const manuId     = process.env.MANU_DISCORD_ID || '366635705964953601';

  try {
    const guild = await client.guilds.fetch(guildId);

    const slug = `coaching-${first_name}${last_name ? '-' + last_name : ''}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 80);

    // Idempotency check — don't create duplicates
    const existing = guild.channels.cache.find(
      ch => ch.name === slug && ch.parentId === categoryId
    );
    if (existing) {
      console.log(`[TWM] Channel already exists: #${slug}`);
      return res.json({
        success: true,
        channel_url: `https://discord.com/channels/${guildId}/${existing.id}`,
        channel_id: existing.id,
        already_existed: true,
      });
    }

    const channel = await guild.channels.create({
      name: slug,
      type: 0, // GUILD_TEXT
      parent: categoryId,
      topic: `1-on-1 coaching channel for ${first_name}${last_name ? ' ' + last_name : ''} | Order #${order_id || 'N/A'}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: ['ViewChannel'],
        },
        {
          id: manuId,
          allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'],
        },
        {
          id: client.user.id,
          allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'],
        },
      ],
    });

    console.log(`[TWM] Created coaching channel #${slug} (${channel.id}) for user ${user_id}`);

    const fullName = [first_name, last_name].filter(Boolean).join(' ');
    await channel.send(
      `👋 **New coaching member alert!**\n\n` +
      `<@${manuId}> — **${fullName}** just joined as a 1-on-1 coaching member.\n\n` +
      `📋 **Details:**\n` +
      `• Name: ${fullName}\n` +
      `• Email: ${email || 'N/A'}\n` +
      `• Order: #${order_id || 'N/A'}\n\n` +
      `Say hi and get the ball rolling! 🏆`
    );

    const channelUrl = `https://discord.com/channels/${guildId}/${channel.id}`;

    return res.json({
      success: true,
      channel_url: channelUrl,
      channel_id: channel.id,
    });

  } catch (err) {
    console.error('[TWM] Failed to create coaching channel:', err);
    return res.status(500).json({ error: 'Failed to create channel', detail: err.message });
  }
});

// ============================================================
// END Train with Manu block
// ============================================================

app.listen(PORT, () => console.log(`[express] Server running on port ${PORT}`));

// ─── Discord client ───────────────────────────────────────────────────────────
const { Client, GatewayIntentBits, Partials, ChannelType, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
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

    if (customId.startsWith('approve_playbook::')) {
      const [, tweetId, driveFileId, messageId] = customId.split('::');
      const playbook = interaction.data.components[0].components[0].value || '';
      const formation = interaction.data.components[1].components[0].value || '';
      const username = interaction.member?.user?.username || interaction.user?.username;
      const token = interaction.token;

      res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

      const stored = draftStore.get(messageId);
      const threadData = stored ? stored.threadData : null;
      const storedDriveFileId = stored ? stored.driveFileId : driveFileId;
      // draft text isn't available here (modal submit has no access to the original
      // message's embed) — pull it back out of the stored draftStore entry if present,
      // otherwise n8n falls back to whatever it already has for this driveFileId.
      const draft = stored?.draft || '';

      console.log(`[approve] messageId: ${messageId}, hasThreadData: ${!!threadData}, playbook: "${playbook}", formation: "${formation}"`);

      const N8N_APPROVAL_WEBHOOK = process.env.N8N_APPROVAL_WEBHOOK;
      if (N8N_APPROVAL_WEBHOOK) {
        await axios.post(N8N_APPROVAL_WEBHOOK, {
          action: 'approve',
          tweetId,
          driveFileId: storedDriveFileId,
          draft,
          threadData,
          playbook: playbook.trim(),
          formation: formation.trim(),
          approvedBy: username,
          timestamp: new Date().toISOString(),
        }).catch(err => console.error('Failed to forward approval:', err.message));
      }

      draftStore.delete(messageId);

      const infoLine = (playbook || formation)
        ? `\n📋 Playbook: **${playbook || '—'}** · Formation: **${formation || '—'}**`
        : '\n📋 _No playbook/formation provided — will auto-detect._';

      await editInteractionMessage(
        token,
        `✅ **Post queued in Hypefury!** It will go live on @MaddenAcademy_ according to the schedule.${infoLine}\n\n_Approved by ${username}_`,
        [],
        []
      ).catch(err => console.error('Failed to update message after approve:', err.message));

      return;
    }

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
        // Ask Manu for playbook/formation before actually approving — both fields
        // optional, so leaving them blank = skip (falls back to existing AI-guess
        // scraping logic on the Railway side).
        return res.json({
          type: 9,
          data: {
            custom_id: `approve_playbook::${tweetId}::${driveFileId}::${messageId}`,
            title: 'Madden School Info (optional)',
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: 'playbook',
                    label: 'Playbook (leave blank to skip)',
                    style: 1,
                    placeholder: 'e.g. San Francisco, New Orleans Saints',
                    required: false,
                    max_length: 100,
                  }
                ]
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: 'formation',
                    label: 'Formation (leave blank to skip)',
                    style: 1,
                    placeholder: 'e.g. Gun Doubles Flex Y Off Close',
                    required: false,
                    max_length: 100,
                  }
                ]
              }
            ]
          }
        });

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
