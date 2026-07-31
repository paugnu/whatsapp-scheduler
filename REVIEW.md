# Revisión técnica y hoja de ruta

## Resumen

La extensión resuelve bien su caso de uso con una superficie pequeña, traducciones amplias y sin dependencias de producción. La principal fragilidad no está en la interfaz, sino en la automatización de una aplicación ajena: los selectores y el flujo de WhatsApp Web pueden cambiar sin aviso.

Esta revisión incorpora una primera mejora de alta prioridad: el proceso de fondo ahora valida todas las solicitudes de creación y edición, limita las programaciones a un año y genera identificadores resistentes a colisiones. Estas reglas están aisladas y cubiertas por pruebas automáticas.

## Hallazgos priorizados

### P0 — Fiabilidad del envío

- **Confirmar el envío de extremo a extremo.** En la actualidad se considera entregado después de interactuar con el botón de envío. Conviene observar que el mensaje aparece en la conversación y distinguir entre “enviado”, “entregado” y “leído”.
- **Recuperar estados interrumpidos.** Un cierre del navegador mientras un mensaje está en estado `sending` puede dejarlo bloqueado. Al arrancar, se deberían devolver a `scheduled` los envíos antiguos sin confirmación, con una política de reintentos y backoff.
- **Serializar cambios de almacenamiento.** Varias alarmas simultáneas pueden modificar el objeto en memoria y persistirlo en distinto orden. Una cola de escritura o una operación transaccional reduciría el riesgo.
- **Esperar la carga inicial antes de procesar eventos.** Los listeners se registran antes de que termine `storage.local.get`; una alarma o solicitud muy temprana podría operar sobre un estado vacío.

### P1 — Mantenibilidad y compatibilidad

- **Dividir `content-script.js`.** Mezcla detección de chats, automatización, internacionalización y construcción de UI. Separar dominio, adaptador de WhatsApp y vistas facilitaría las pruebas.
- **Añadir pruebas de DOM.** Cubrir búsqueda exacta de chats, chats duplicados, cambio de conversación y detección del compositor con fixtures anonimizados.
- **Definir soporte real por navegador.** El manifiesto es MV2 y el fallback `browser = chrome` no convierte las APIs de callbacks de Chrome en promesas. Se debe incorporar un polyfill probado o declarar Firefox como único navegador soportado.
- **Preparar Manifest V3.** Mantener una rama o plan para service workers, evitando estado exclusivamente en memoria y temporizadores largos.
- **Automatizar calidad.** Añadir lint/format, validación del manifiesto, comprobación de todos los JSON de locales y CI en cada cambio.

### P2 — Producto, UX y accesibilidad

- **Mostrar zona horaria y fecha absoluta** también para programaciones relativas, especialmente cerca de cambios de horario de verano.
- **Permitir reintentar y duplicar** mensajes fallidos desde el historial, con el motivo del error traducido.
- **Mejorar accesibilidad.** Incorporar `aria-label`, estados de foco visibles, cierre con Escape, trampa de foco en el diálogo y navegación completa por teclado.
- **Adaptar tema y viewport.** El panel usa colores y posiciones fijas; debería respetar tema claro/oscuro, zoom, ventanas estrechas y dirección RTL.
- **Evitar cierres inesperados.** Avisar si se cierra el editor con texto sin guardar.

### P2 — Privacidad, seguridad y operación

- **Documentar el modelo de privacidad.** Explicar claramente que texto, destinatario e historial se guardan localmente y durante cuánto tiempo.
- **Reducir permisos.** Evaluar si `tabs` puede sustituirse por permisos más específicos en la futura variante MV3.
- **Mantener la validación del emisor.** El proceso de fondo rechaza ya solicitudes ajenas a WhatsApp Web; conviene cubrir esta frontera con pruebas de integración del navegador.
- **Eliminar contenido sensible de logs.** Mantener logging estructurado y desactivable; nunca registrar el cuerpo de mensajes.
- **Añadir telemetría solo mediante consentimiento explícito.** Si se necesita diagnóstico, recoger únicamente errores técnicos anonimizados.

## Secuencia recomendada

1. Recuperación de `sending`, espera de inicialización y cola de persistencia.
2. Suite de pruebas del adaptador DOM con fixtures y CI.
3. Separación modular del content script y accesibilidad del panel.
4. Decisión explícita Firefox/Chrome y prototipo MV3.
5. Política de privacidad, documentación de instalación, soporte y publicación reproducible.

## Criterios de éxito sugeridos

- Ningún mensaje permanece en `sending` más de cinco minutos.
- Las operaciones de crear, editar, cancelar y recuperar tienen pruebas automatizadas.
- Los selectores rotos producen un error accionable y no envían al chat equivocado.
- El panel supera una auditoría WCAG 2.2 AA básica por teclado y contraste.
- Cada versión se construye y valida desde CI con un artefacto reproducible.
