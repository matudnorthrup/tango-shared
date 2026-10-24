// Placeholder Discord credentials so nothing under test can reach a real guild.
process.env.DISCORD_TOKEN ??= "test-discord-token";
process.env.DISCORD_GUILD_ID ??= "100000000000000001";
