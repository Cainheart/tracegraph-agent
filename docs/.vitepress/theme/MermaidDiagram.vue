<script setup>
import { computed, onMounted, ref, useId, watch } from "vue";
import { useData } from "vitepress";
const props = defineProps({ encoded: { type: String, required: true } });
const id = `diagram-${useId().replaceAll(':', '-')}`;
const { isDark } = useData();
const element = ref(null);
const error = ref("");
const source = computed(() => new TextDecoder().decode(Uint8Array.from(globalThis.atob(props.encoded), (character) => character.charCodeAt(0))));
async function render() {
  if (!element.value) return;
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark.value ? "dark" : "default" });
    const result = await mermaid.render(id, source.value);
    element.value.innerHTML = result.svg;
    result.bindFunctions?.(element.value);
    const svg = element.value.querySelector("svg");
    if (svg?.viewBox.baseVal.width) {
      svg.style.width = `${svg.viewBox.baseVal.width}px`;
      svg.style.maxWidth = "none";
    }
    element.value.dataset.rendered = "true";
    error.value = "";
  } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
}
onMounted(render);
watch([source, isDark], render);
</script>

<template>
  <figure class="canonical-diagram" tabindex="0" aria-label="Architecture diagram; scroll horizontally for wide diagrams">
    <div ref="element" role="img" aria-label="Mermaid architecture diagram"><pre>{{ source }}</pre></div>
    <p v-if="error" role="alert">Diagram rendering failed: {{ error }}</p>
    <details><summary>Diagram source</summary><pre>{{ source }}</pre></details>
  </figure>
</template>
