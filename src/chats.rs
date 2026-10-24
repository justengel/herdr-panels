use std::path::Path;

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::layout::is_layout_id;
use crate::store::write_atomic;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub panel_id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
}

pub fn load(config_dir: &Path, chat_id: &str) -> anyhow::Result<Transcript> {
    validate_chat_id(chat_id)?;
    let path = config_dir.join("chats").join(format!("{chat_id}.json"));
    if !path.is_file() {
        return Ok(Transcript {
            messages: Vec::new(),
        });
    }
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let transcript: Transcript =
        serde_json::from_str(&text).context("chat transcript is invalid")?;
    transcript.validate()?;
    Ok(transcript)
}

pub fn save(config_dir: &Path, chat_id: &str, transcript: &Transcript) -> anyhow::Result<()> {
    validate_chat_id(chat_id)?;
    transcript.validate()?;
    let bytes = serde_json::to_vec_pretty(transcript).context("encoding chat transcript")?;
    let mut body = bytes;
    body.push(b'\n');
    write_atomic(
        &config_dir.join("chats").join(format!("{chat_id}.json")),
        &body,
    )
    .context("writing chat transcript")
}

pub fn chat_id(layout_id: &str, panel_id: &str) -> String {
    format!("{layout_id}..{panel_id}")
}

fn validate_chat_id(id: &str) -> anyhow::Result<()> {
    let Some((layout_id, panel_id)) = id.split_once("..") else {
        bail!("invalid chat id");
    };
    if !is_layout_id(layout_id) || panel_id.is_empty() || panel_id.len() > 49 {
        bail!("invalid chat id");
    }
    if !panel_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        bail!("invalid chat id");
    }
    if layout_id.contains('.') || panel_id.contains('.') {
        bail!("invalid chat id");
    }
    Ok(())
}

impl Transcript {
    fn validate(&self) -> anyhow::Result<()> {
        if self.messages.len() > 200 {
            bail!("a chat keeps at most 200 messages");
        }
        for message in &self.messages {
            if message.id.len() > 40
                || message.id.is_empty()
                || !message
                    .id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            {
                bail!("invalid chat message id");
            }
            if message.role != "user" && message.role != "agent" {
                bail!("unsupported chat role");
            }
            if message.text.chars().count() > 8_000 {
                bail!("chat message is too long");
            }
            if message.at.chars().count() > 40 {
                bail!("chat timestamp is too long");
            }
            if message.attachments.len() > 12 {
                bail!("a message can attach at most 12 components");
            }
            for attachment in &message.attachments {
                if !is_short(&attachment.panel_id, 49)
                    || !is_short(&attachment.kind, 24)
                    || !is_short(&attachment.title, 80)
                    || attachment.summary.chars().count() > 500
                {
                    bail!("chat attachment is too long");
                }
            }
        }
        Ok(())
    }
}

fn is_short(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_transcript() {
        let dir = std::env::temp_dir().join(format!("hwp-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let transcript = Transcript {
            messages: vec![ChatMessage {
                id: "m1".into(),
                role: "user".into(),
                text: "Look at this panel".into(),
                attachments: vec![Attachment {
                    panel_id: "notes".into(),
                    kind: "markdown".into(),
                    title: "Notes".into(),
                    summary: "h2: The terminal".into(),
                }],
                at: "2026-10-22T00:00:00.000Z".into(),
            }],
        };
        let id = chat_id("side-by-side", "chat");
        save(&dir, &id, &transcript).unwrap();
        assert_eq!(load(&dir, &id).unwrap(), transcript);
        assert!(validate_chat_id("side-by-side..chat").is_ok());
        assert!(validate_chat_id("../secret").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
