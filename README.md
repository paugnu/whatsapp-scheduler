# WhatsApp Message Scheduler

Extensión para programar mensajes desde WhatsApp Web. La extensión guarda las programaciones en el almacenamiento local de Firefox; el navegador y la sesión de WhatsApp deben estar disponibles cuando llegue la hora del envío.

## Probarla temporalmente en Firefox

### Requisitos

- Firefox 142 o posterior.
- Una sesión iniciada en [WhatsApp Web](https://web.whatsapp.com/).
- Este repositorio descargado y descomprimido, o clonado con Git.

### Cargar la extensión

1. Abre Firefox y escribe `about:debugging#/runtime/this-firefox` en la barra de direcciones.
2. Pulsa **Cargar complemento temporal…**.
3. Selecciona el archivo `manifest.json` de la raíz de este proyecto.
4. Comprueba que aparece **WhatsApp Message Scheduler** en la lista de extensiones temporales.
5. Abre o recarga `https://web.whatsapp.com/` después de cargarla.

La instalación temporal desaparece al cerrar Firefox. Para volver a probarla tras reiniciar el navegador, repite estos pasos.

## Prueba manual recomendada

1. Abre una conversación cuyo nombre sea inequívoco.
2. Pulsa el botón verde con el calendario, situado en la esquina inferior derecha. También puedes usar `Ctrl+Shift+W`.
3. Escribe un mensaje fácilmente reconocible, por ejemplo `Prueba del programador 12:30`.
4. Elige **Enviar después**, introduce `0` horas y `1` minuto, y pulsa **Programar**.
5. Abre **Lista** y comprueba que el mensaje figura como programado para la conversación correcta.
6. Mantén Firefox abierto y la sesión de WhatsApp Web iniciada hasta que se cumpla el minuto.
7. Comprueba que el mensaje se envía una sola vez y que su estado cambia a enviado.

Haz la primera prueba en un chat propio o con una persona avisada: esta extensión automatiza un envío real.

## Casos que conviene verificar

- **Cancelar:** programa un mensaje a cinco minutos, cancélalo desde **Lista** y confirma que nunca se envía.
- **Editar:** cambia tanto el texto como la hora y comprueba que solo se utiliza la versión nueva.
- **Fecha absoluta:** programa una fecha y hora futuras y confirma que corresponde a la zona horaria del sistema.
- **Reinicio:** programa un mensaje, reinicia Firefox, vuelve a cargar temporalmente la extensión y comprueba que la programación sigue en la lista.
- **Chat duplicado:** prueba nombres de chat similares y verifica que la extensión no elige silenciosamente el chat incorrecto.
- **Límite:** confirma que no permite mensajes vacíos, más de 4096 caracteres, fechas pasadas o más de un año en el futuro.

## Ver errores y diagnosticar

### Proceso de fondo

En `about:debugging#/runtime/this-firefox`, localiza la extensión y pulsa **Inspeccionar**. La consola que se abre muestra los mensajes que empiezan por `[BG]`.

### Código integrado en WhatsApp Web

Con WhatsApp Web abierto, pulsa `F12`, entra en **Consola** y busca mensajes que empiecen por `[WA Scheduler]`.

Si el botón no aparece:

1. Confirma que la extensión sigue listada en `about:debugging`.
2. Recarga WhatsApp Web después de cargar la extensión.
3. Espera unos segundos a que termine de cargar la interfaz.
4. Revisa ambas consolas y copia el error completo, la versión de Firefox y los pasos para reproducirlo, evitando incluir textos privados o nombres de contactos.

## Comprobaciones para desarrollo

Con Node.js 18 o posterior:

```bash
npm test
npm run check
```

Después de modificar un archivo de la extensión, vuelve a `about:debugging`, pulsa **Recargar** junto a la extensión y recarga también la pestaña de WhatsApp Web.

## Limitaciones actuales

- Es una extensión Manifest V2 orientada a Firefox.
- Depende de la estructura interna de WhatsApp Web, que puede cambiar sin previo aviso.
- No puede enviar si Firefox no está ejecutándose, la sesión ha caducado o WhatsApp Web no termina de cargar.
- Una instalación temporal no permanece instalada tras cerrar Firefox, aunque sus datos locales pueden seguir disponibles al volver a cargarla con el mismo perfil.
