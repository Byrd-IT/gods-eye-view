<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '../../i18n/index.js';
import { createOpacityRow } from '../../byrdit/layerOpacity/opacityRow.js';

// Byrd-IT fork: hosts the plain-DOM Opacity slider (byrdit/layerOpacity) in a
// Vue-rendered layer row. The control owns its element; this only mounts and
// disposes it with the row.
const props = defineProps({
  model: { type: Object, default: null },
  layerId: { type: String, required: true },
  label: { type: String, default: '' },
});
const host = ref(null);
let control = null;
onMounted(() => {
  if (!props.model || !host.value) return;
  control = createOpacityRow({
    documentRef: host.value.ownerDocument,
    model: props.model,
    layerId: props.layerId,
    label: props.label,
    translate: (text) => t(text),
  });
  host.value.append(control.element);
});
onBeforeUnmount(() => control?.dispose());
</script>

<template>
  <div ref="host" class="layer-opacity-host" style="display: contents"></div>
</template>
