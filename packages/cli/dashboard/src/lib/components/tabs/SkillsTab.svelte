<script lang="ts">
	import { onMount } from "svelte";
	import {
		getSkills,
		searchSkills,
		installSkill,
		uninstallSkill,
		type Skill,
	} from "$lib/api";

	let skills = $state<Skill[]>([]);
	let skillsLoading = $state(false);
	let skillSearchQuery = $state("");
	let skillSearchResults = $state<
		Array<{ name: string; description: string; installed: boolean }>
	>([]);
	let skillSearching = $state(false);
	let skillInstalling = $state<string | null>(null);
	let skillUninstalling = $state<string | null>(null);
	let selectedSkill = $state<Skill | null>(null);

	async function fetchSkills() {
		skillsLoading = true;
		skills = await getSkills();
		skillsLoading = false;
	}

	async function doSkillSearch() {
		if (!skillSearchQuery.trim()) {
			skillSearchResults = [];
			return;
		}
		skillSearching = true;
		skillSearchResults = await searchSkills(skillSearchQuery.trim());
		skillSearching = false;
	}

	async function doInstallSkill(name: string) {
		skillInstalling = name;
		const result = await installSkill(name);
		if (result.success) {
			await fetchSkills();
			skillSearchResults = skillSearchResults.map((s) =>
				s.name === name ? { ...s, installed: true } : s,
			);
		}
		skillInstalling = null;
	}

	async function doUninstallSkill(name: string) {
		skillUninstalling = name;
		const result = await uninstallSkill(name);
		if (result.success) {
			await fetchSkills();
			skillSearchResults = skillSearchResults.map((s) =>
				s.name === name ? { ...s, installed: false } : s,
			);
			if (selectedSkill?.name === name) {
				selectedSkill = null;
			}
		}
		skillUninstalling = null;
	}

	onMount(() => {
		fetchSkills();
	});
</script>

<div class="skills-container">
	<div class="skills-search">
		<input
			type="text"
			class="skills-search-input"
			bind:value={skillSearchQuery}
			onkeydown={(e) => e.key === 'Enter' && doSkillSearch()}
			placeholder="Search skills.sh..."
		/>
		<button
			class="btn-primary"
			onclick={doSkillSearch}
			disabled={skillSearching || !skillSearchQuery.trim()}
		>
			{skillSearching ? 'Searching...' : 'Search'}
		</button>
	</div>

	{#if skillSearchResults.length > 0}
		<div class="skills-section">
			<div class="skills-section-title">Search Results</div>
			<div class="skills-list">
				{#each skillSearchResults as result}
					<div class="skill-item">
						<div class="skill-info">
							<span class="skill-name">{result.name}</span>
							{#if result.installed}
								<span class="skill-badge installed">Installed</span>
							{/if}
						</div>
						<div class="skill-description">{result.description}</div>
						<div class="skill-actions">
							{#if result.installed}
								<button
									class="btn-danger-small"
									onclick={() => doUninstallSkill(result.name)}
									disabled={skillUninstalling === result.name}
								>
									{skillUninstalling === result.name ? '...' : 'Uninstall'}
								</button>
							{:else}
								<button
									class="btn-primary-small"
									onclick={() => doInstallSkill(result.name)}
									disabled={skillInstalling === result.name}
								>
									{skillInstalling === result.name ? '...' : 'Install'}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<div class="skills-section">
		<div class="skills-section-title">Installed ({skills.length})</div>
		<div class="skills-list">
			{#if skillsLoading}
				<div class="skills-empty">Loading skills...</div>
			{:else if skills.length === 0}
				<div class="skills-empty">No skills installed. Search above to find skills.</div>
			{:else}
				{#each skills as skill}
					<div class="skill-item" class:skill-selected={selectedSkill?.name === skill.name}>
						<div class="skill-info">
							<span class="skill-name">{skill.name}</span>
							{#if skill.builtin}
								<span class="skill-badge builtin">Built-in</span>
							{/if}
							{#if skill.user_invocable}
								<span class="skill-badge invocable">/{skill.name}</span>
							{/if}
						</div>
						<div class="skill-description">{skill.description}</div>
						<div class="skill-actions">
							{#if !skill.builtin}
								<button
									class="btn-danger-small"
									onclick={() => doUninstallSkill(skill.name)}
									disabled={skillUninstalling === skill.name}
								>
									{skillUninstalling === skill.name ? '...' : 'Uninstall'}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>
