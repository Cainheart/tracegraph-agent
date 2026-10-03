<script setup>
import { computed } from "vue";
import { useData } from "vitepress";
const { frontmatter } = useData();
const meta = computed(() => frontmatter.value.projection);
const language = computed(() => ({ en: "English canonical source", "zh-CN": "中文规范源文档", mul: "Bilingual canonical index" })[meta.value?.locale]);
</script>

<template>
  <aside v-if="meta" class="projection-meta" aria-label="Document provenance">
    <div class="projection-badges">
      <span class="projection-status" :class="meta.status">{{ meta.status === 'proposed' ? 'PROPOSED · design, not shipped behavior' : 'CURRENT · reference' }}</span>
      <span>{{ meta.version }}</span><span>{{ language }}</span>
    </div>
    <p>Local preview · canonical documents only. Reviewed translations and archived versions are not available.</p>
    <details>
      <summary>Source and snapshot</summary>
      <p><a :href="meta.sourceDownload" target="_blank" rel="noopener">Open exact Markdown source</a> · <code>{{ meta.sourcePath }}</code></p>
      <p class="source-digest"><code>{{ meta.sourceDigest }}</code></p>
      <p>{{ meta.dirty ? 'Uncommitted working-tree snapshot; remote files may differ.' : 'Clean source snapshot.' }} Base commit: <code>{{ meta.sourceCommit || 'unavailable' }}</code></p>
    </details>
  </aside>
</template>
