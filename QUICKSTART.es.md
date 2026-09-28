# Guía rápida en español — Pi Telegram Bridge

> Esta guía está en español, pero **las pantallas del producto están en inglés a propósito** (así lo define el contrato de textos del proyecto). Cuando la ventana de configuración o el comando `/tg` muestren palabras en inglés, esta guía te explica qué significan. La guía canónica y completa está en el [README.md](README.md) (en inglés).

## Qué es esto

- **Pi** es un agente de programación con IA que corre en una ventana de terminal de tu PC: le escribes qué quieres hacer y él escribe y modifica código en tu proyecto.
- **Este puente (bridge)** es un pequeño programa que vive en tu propio PC y conecta tu chat privado de Telegram con Pi. No hay nada alojado en internet: si tu PC está apagado o en suspensión, el puente también lo está.
- **A tu teléfono llegan solo las respuestas finales de Pi** — nunca tus archivos, nunca tu terminal, nunca el razonamiento interno de Pi.
- **No es acceso remoto a tu PC:** no puedes ejecutar comandos CMD ni PowerShell desde el teléfono, y el puente no abre ningún puerto de escucha.

## Requisitos (2 minutos)

| Qué necesitas | Cómo verificarlo | Dónde conseguirlo |
|---|---|---|
| Windows 11 con PowerShell 5.1 o posterior | Casi seguro ya lo tienes: Windows 11 incluye PowerShell 5.1. | Ya viene incluido en Windows 11. |
| Node.js **24 o más reciente** | Abre el Símbolo del sistema (tecla Windows, escribe `cmd`, Enter), escribe `node --version` y presiona Enter. | [https://nodejs.org](https://nodejs.org) — descarga el instalador LTS y ejecútalo. |
| Pi instalado y funcionando en esta misma PC | Abre Pi en una terminal y úsalo al menos una vez con normalidad. | Tu instalación existente de Pi. |
| Telegram con sesión iniciada en tu teléfono | Abre Telegram y confirma que iniciaste sesión. | [https://telegram.org](https://telegram.org) o la tienda de apps de tu teléfono. |

Un requisito más, que no se descarga: **tu PC tiene que estar encendida, despierta y con internet mientras usas el puente.** No hay nada alojado en la nube. Si la PC entra en suspensión o se queda sin conexión, el bot no puede responder hasta que vuelva.

La verificación de Node.js es la que suele fallar. Dos mensajes que puedes ver al escribir `node --version`:

- **`'node' is not recognized`** — Node.js no está instalado. Instala la versión actual desde [https://nodejs.org](https://nodejs.org), **cierra el Símbolo del sistema y abre uno nuevo** para que Windows encuentre el programa recién instalado, y prueba de nuevo.
- **Una versión que empieza con `v18.` o `v22.`** — Node.js está instalado pero es demasiado antiguo para este puente. Instala la versión actual desde [https://nodejs.org](https://nodejs.org) y vuelve a verificar.

Tranquilidad: el instalador ahora **rechaza un Node.js no compatible antes de preguntarte nada** — antes del token del bot, antes del teléfono, antes de tocar cualquier configuración. Si tu Node.js es antiguo, te enteras de inmediato y con un mensaje claro, y nada queda modificado en tu PC.

## Paso 1 — llevar los archivos a tu PC

Necesitas **la carpeta completa** del proyecto, no solo el README.

- **Si te pasaron un archivo ZIP:** haz clic derecho sobre el ZIP y elige **Extraer todo...**. Elige una ruta simple y corta, por ejemplo `C:\pi-telegram-bridge`, y termina la extracción. No ejecutes la herramienta desde dentro de la ventana del ZIP: siempre desde la carpeta extraída.
- **Si usas git:** ejecuta `git clone https://github.com/AgusLoza2021/pi-telegram-bridge.git` en una terminal.

Dos lugares a evitar:

- **No** pongas la carpeta dentro de OneDrive ni de otra carpeta sincronizada: la sincronización puede interferir con los archivos locales del puente.
- **No** pongas la carpeta dentro de `C:\Program Files` o `C:\Program Files (x86)`: las protecciones de Windows estorban al instalador.

Una ruta simple como `C:\pi-telegram-bridge` funciona bien.

## Paso 2 — crear tu bot de Telegram

1. Abre Telegram en tu teléfono y busca la cuenta oficial verificada **@BotFather**.
2. Envíale el mensaje `/newbot`. Te hace dos preguntas: un nombre para mostrar y un nombre de usuario que termine en `bot`.
3. BotFather te responde con un **token**: una línea larga de letras, números y dos puntos. Cópialo en un lugar privado de tu PC. **Trátalo como una contraseña:** quien lo tenga puede usar tu bot. Nunca lo pongas en issues, chats, registros ni capturas de pantalla.
4. Recomendado: en BotFather, entra a los ajustes de tu bot y desactiva **Allow Groups**. Así tu bot queda privado solo para ti.

## Paso 3 — ejecutar la configuración

1. Abre la carpeta que extrajiste en el Paso 1 (por ejemplo `C:\pi-telegram-bridge`).
2. Haz doble clic en **`Setup Pi Telegram.cmd`**. Se abre una ventana negra: es normal.
3. La ventana prepara unos archivos locales; si falta un paquete auxiliar pequeño, lo descarga de internet. Suele tardar uno o dos minutos.
4. Cuando te lo pida, **pega el token del Paso 2**. La ventana oculta lo que pegas. El token queda en tu PC, guardado de forma cifrada (protegido para tu cuenta de Windows), y nunca se escribe ni se muestra en ningún otro lado.
5. La ventana muestra un **código QR**. Abre la cámara del teléfono, apúntala al código; Telegram abre tu bot y tocas **Start**. El código contiene solo el nombre del bot y un código de emparejamiento de un solo uso — nunca el token.
6. La ventana espera hasta un minuto. Cuando reconoce tu teléfono, te pide escribir **ENROLL** para confirmar. Nada se guarda hasta que lo hagas.
7. Después de confirmar, la ventana instala un auxiliar dentro de Pi (queda inactivo hasta que tú vincules una ventana en el Paso 4) y configura la conexión de fondo, pero **la deja apagada**: no arranca nada al iniciar sesión. Cuando la quieras usar, abrí un Símbolo del sistema en esta carpeta y escribí `telegram on`. A partir de ahí la manejás vos: `telegram off` la apaga y `telegram status` te muestra cómo está. También podés hacer doble clic en `telegram.cmd` en el Explorador: abre un menú que te muestra cómo está la conexión y te deja prenderla o apagarla (escribir `telegram on|off|status` en el Símbolo del sistema sigue funcionando exactamente igual). Si la apagás, queda apagada incluso si reiniciás Windows; la prendés de nuevo con `telegram on`.

Si algo falla, tu configuración anterior queda intacta y no se guarda nada a medias. Mira la sección "Los fallos más comunes" más abajo.

## Paso 4 — vincular Pi y hablar

Cada ventana de Pi queda **desconectada hasta que tú la vincules** — esto es intencional.

1. Abre Pi en una terminal de tu PC. Si Pi ya estaba abierto durante la configuración, escribe `/reload` una vez para que descubra el auxiliar nuevo.
2. Escribe `/tg` y elige **Connect** en la confirmación que aparece.
3. Envía un mensaje de texto normal a tu bot desde el teléfono.

La respuesta final de Pi llega al mismo chat.

## Cómo sé que funcionó

Cuatro cosas, en orden:

1. La ventana de configuración terminó con las palabras **`Setup complete.`** ("Configuración completa").
2. Después de escribir `/tg` y elegir Connect, Pi respondió con un mensaje que empieza con **"Linked. Send a message from your phone..."** ("Vinculado. Envía un mensaje desde tu teléfono...").
3. Un mensaje normal que escribiste en el teléfono llegó a Pi como instrucción.
4. La respuesta final de Pi volvió al mismo chat de Telegram.

## El panel de Projects: elegir a qué Pi le hablás

Con una sola ventana de Pi vinculada no tenés que elegir nada: los mensajes van solos. Con varias, el botón **Projects** abre un panel compacto donde elegís a qué ventana le hablás (el comando `/projects` muestra lo mismo, pero es de la capa avanzada; el botón es el camino para principiantes). **Las palabras de la pantalla están en inglés a propósito** — esta tabla te dice qué significa cada una:

| Palabra en inglés | Qué significa |
|---|---|
| **Projects** | Proyectos: abre (o actualiza) el panel. |
| **Active now** | "Activos ahora": una fila por cada ventana de Pi vinculada con `/tg` que sigue corriendo. |
| **Recent** | "Recientes": proyectos vistos en los últimos 30 días (como máximo 20, del más nuevo al más viejo) que ahora mismo no tienen ninguna ventana corriendo. |
| **Available** | "Disponible": esa Pi está corriendo y libre. |
| **Working** / **Waiting** | "Trabajando" / "Esperando": esa Pi está corriendo pero en medio de una tarea. |
| **Offline** | "Desconectado": fila de **Recent**. No se puede tocar y jamás se le envía nada. |
| **Refresh** | "Actualizar": recarga el panel. |
| **Status** / **Disconnect** / **Stop the task** | "Estado" / "Desvincular" / "Detener la tarea". |

Cómo leer una fila:

- El **cuadrado de color** (🟦 🟪 🟧 🟩 🟨 🟫 ⬛ ⬜) es estable: el mismo proyecto siempre lleva el mismo color. `⬜` puede ser simplemente el color de esa carpeta (la paleta tiene ocho espacios y `⬜` es uno de ellos) o el neutral cuando no se pudo derivar un color; en cualquier caso orienta, no marca un error.
- El **círculo de estado y la palabra** (🟢 Available, 🟡 Working/Waiting, ⚪ Offline) te dicen cómo está: el color nunca es la única señal.
- El **✓** marca la fila elegida (resaltada en azul): es la Pi que recibe tus mensajes.
- El **nombre** es el alias que le pusiste con `/alias`, o el nombre de la carpeta del proyecto; cuando entra completa, se muestra también la rama de git entre paréntesis.

Tres reglas del panel:

1. Tocás una fila de **Active now** y, desde ese momento, tus mensajes van a esa Pi. Si tenés un mensaje guardado esperando destino, tocar una fila activa lo envía ahí.
2. Tu elección sobrevive a que el puente se reinicie en tu PC, pero solo si la misma ventana exacta y el mismo proyecto siguen corriendo cuando vuelve. A una ventana cerrada o vieja nunca se le envía nada: el bot te pide elegir de nuevo.
3. Cada respuesta final de Pi nombra la ventana que la produjo: cuadrado de color, nombre de la ventana y su rama de git cuando entra completa. Las confirmaciones del bot también nombran a esa ventana siempre que el puente todavía sabe de qué Pi se trata; las pantallas globales y las confirmaciones genéricas pueden llegar sin nombre de ventana.

### Nombrar una ventana: `/alias`

`/alias <nombre>` le pone un nombre legible a la ventana de Pi seleccionada — por ejemplo `/alias Home PC` — y `/alias clear` lo borra. Sirve sobre todo cuando tenés **varias ventanas del mismo proyecto**: el nombre distingue ventana por ventana, no solo proyecto por proyecto. Reglas:

- Hasta 64 caracteres normales; si el nombre no sirve, el bot lo rechaza con un mensaje fijo y nunca te muestra lo que escribiste.
- El nombre **sobrevive a que el puente se reinicie** y a que la misma ventana se reconecte (queda guardado hasta 30 días mientras la ventana no se cierre del todo).
- Si **cerrás la ventana de Pi y abrís una nueva**, esa ventana nueva arranca con su etiqueta por defecto otra vez: el alias no salta de ventana.

## Cuando Pi te hace una pregunta

Mientras trabaja, Pi a veces necesita que elijas entre 2 y 4 opciones — por ejemplo, cuál de dos correcciones aplicar. Puedes responder desde el teléfono:

1. Pi hace una pregunta normal con 2–4 opciones.
2. El bot la muestra como una tarjeta con **un botón por opción**, más un botón **Cancel this question** (cancelar esta pregunta).
3. Toca una opción y esa misma Pi continúa con tu elección. Toca **Cancel this question** y no se elige nada.

Reglas simples:

- Solo hay **una pregunta a la vez por ventana de Pi**, y cada pregunta vence a los **30 minutos**. Cuando vence no llega ningún mensaje de Telegram: la herramienta simplemente agota su tiempo en la PC. Solo si tocas una tarjeta vencida responde el bot con el aviso fijo de pregunta desactualizada; Pi vuelve a preguntar si todavía lo necesita.
- **Escribir texto no es una respuesta.** Mientras una pregunta está pendiente, la única forma de responderla es con los botones de la propia tarjeta.
- Esto sirve solo para decisiones normales de la tarea en curso. Los permisos, aprobaciones y avisos de seguridad que Pi muestra en la pantalla de la PC nunca se convierten en botones de Telegram.
- Si actualizaste el puente y la pregunta no aparece, la ventana de Pi que ya estaba abierta puede necesitar `/reload` una vez — la misma regla de siempre después de instalar o actualizar.

En la PC, esta función es la herramienta interna `telegram_ask_user_choice` de la extensión. No necesitas hacer nada con ella: aparece sola cuando Pi pregunta. Los comandos siguen siendo parte de la capa avanzada.

## Enviar una foto al teléfono

Puedes enviar una imagen desde tu PC a tu propio chat privado, sin abrir Telegram en la PC:

```
node scripts/send-photo.mjs "C:\pi-telegram-bridge\captura.png"
```

Ejecútalo desde la carpeta del proyecto, la misma que contiene `Setup Pi Telegram.cmd`. La última línea que imprime es `SENT` y la imagen aparece en tu chat. El destino no se puede elegir: un envío real siempre va al chat privado que emparejaste en el Paso 3, porque el identificador del chat nunca se acepta desde la línea de comandos.

Estas comprobaciones se hacen **antes** de subir nada, y un archivo que falle cualquiera de ellas nunca se envía:

| Regla | Valor |
|---|---|
| Formatos permitidos | `.png`, `.jpg`, `.jpeg`, `.webp` |
| Tamaño máximo | 10 MB |
| Dónde puede estar el archivo | Dentro de la carpeta del proyecto. Si la imagen está en otro lado, agrega `--root "C:\la\carpeta"`. |

Dos opciones más:

- **`--caption "texto"`** envía un texto junto con la imagen. Siempre es texto plano: nunca se le aplica formato.
- **`--dry-run`** valida el archivo y arma exactamente la petición que se enviaría, pero no envía nada ni revela tus credenciales.

Con `node scripts/send-photo.mjs --help` ves todas las opciones y los límites.

Dos cosas que conviene saber:

- Es un comando **de la PC**. Nada desde tu teléfono puede extraer una imagen de tu disco.
- Tu token nunca se imprime, ni se registra, ni se escribe en la línea de comandos, y si algo falla verás un código corto en lugar de un error largo.

## Enviar una nota de voz desde el teléfono (se convierte en texto)

En lugar de escribir, grabá una nota de voz en tu chat privado. El puente la transcribe **en tu PC, localmente** — el audio nunca sale de tu máquina — y el texto le llega a la ventana de Pi vinculada exactamente como si lo hubieras tipeado. Los audios reenviados funcionan igual.

Necesita una configuración única que **nunca se hace automáticamente** — el proyecto no descarga binarios por su cuenta:

1. Descargá el zip de binarios de Windows de whisper.cpp desde sus releases de GitHub (la versión `v1.9.2` es la última que publica `whisper-bin-x64.zip`) y extraé `whisper-cli.exe` con sus archivos `.dll` en `.local/tools/whisper/`.
2. Descargá el modelo `ggml-small.bin` (~466 MB) en `.local/tools/whisper/models/`.
3. Poné `ffmpeg.exe` en `.local/tools/ffmpeg/ffmpeg.exe`, o apuntá la configuración a un ffmpeg que ya tengas (se exige una ruta absoluta completa).

Esa estructura de carpetas es la configuración por defecto; cada valor se puede sobrescribir en la sección `transcription` de la configuración (rutas, idioma, cantidad de hilos, límites y el vocabulario técnico que ayuda a que el dictado en español sobreviva a palabras en inglés como "retry" o "merge").

Límites duros que protegen el loop de polling: máximo 20 MB por audio, máximo 5 minutos (medidos sobre el audio convertido, no según lo que dice Telegram), timeout de 2 minutos por proceso (un proceso colgado se mata, nunca se espera), y todo corre en tu CPU: nunca se contacta ningún servicio en la nube.

Si el audio no se puede transcribir (falta una herramienta, archivo demasiado grande, fallo del decodificador), el bot responde con un mensaje fijo corto y el puente sigue funcionando — nada se traba.

## Los fallos más comunes

| Síntoma | Qué hacer |
|---|---|
| La configuración dice que necesita un Node.js más reciente (`This setup needs a newer Node.js...`) | Tienes Node.js 18 o 22. Instala la versión actual desde [https://nodejs.org](https://nodejs.org), cierra la ventana de configuración y ejecuta `Setup Pi Telegram.cmd` de nuevo. Nada quedó modificado en tu PC. |
| `'node' is not recognized` al verificar la versión | Node.js no está instalado. Instálalo desde [https://nodejs.org](https://nodejs.org) y, después, cierra y vuelve a abrir el Símbolo del sistema para que Windows reconozca el programa nuevo. |
| Hiciste doble clic en el archivo de configuración **desde dentro del ZIP** | Windows lo ejecuta desde una carpeta temporal que no tiene el resto de los archivos del proyecto, y la configuración puede avisarte de que falta algo que en realidad sí tienes. Cierra esa ventana, extrae el ZIP correctamente (clic derecho → **Extraer todo...**) y ejecuta `Setup Pi Telegram.cmd` desde la carpeta extraída. |
| El código QR expiró o no se puede escanear | Cierra la configuración y ejecuta `Setup Pi Telegram.cmd` de nuevo para obtener un código nuevo. Sube el brillo de la pantalla y acerca el teléfono. |
| El bot dice que no hay Pi conectado (`no Pi window is connected`) | Abre Pi en la PC, escribe `/tg` y elige **Connect**. |
| Tenés varias ventanas de Pi vinculadas | Tocá **Projects** y elegí la fila que corresponda: la fila con `✓` es la que recibe tus mensajes. |
| Al enviar una foto imprime `FAILED: ...` | Cada código nombra una sola causa. `path_escape`: el archivo está fuera de la carpeta del proyecto — esta comprobación va primero, así que la ves incluso si el archivo además no existe o tiene mal el nombre; agrega `--root "C:\la\carpeta"` si la imagen está en otro lado. `not_found` o `not_a_file`: no hay nada legible en esa ruta. `bad_extension`: no es `.png`, `.jpg`, `.jpeg` ni `.webp`. `too_large`: supera los 10 MB. `bad_root`: la carpeta que pasaste en `--root` no existe. |
| El bot responde "I couldn't transcribe that audio" | Verificá que existan los tres archivos: `.local/tools/whisper/whisper-cli.exe`, `.local/tools/whisper/models/ggml-small.bin` y `.local/tools/ffmpeg/ffmpeg.exe`. Un audio de más de 20 MB o de más de 5 minutos se rechaza por diseño. Si acabás de instalar las herramientas no hace falta reiniciar nada — la próxima nota de voz las usa. |
| Querés apagar la transcripción de voz | Poné `transcription.enabled` en `false` en tu configuración local. Las notas de voz pasan a comportarse como si la función no existiera: se consumen en silencio y no corre ninguna herramienta. |

Para más síntomas y soluciones, mira la sección [Fix problems del README](README.md#fix-problems).

## Mini glosario

| Palabra | Qué significa aquí |
|---|---|
| **Bot** | Una cuenta de Telegram manejada por un programa en lugar de una persona. Creas el tuyo con @BotFather y solo tú puedes hablar con él. |
| **Token** | La contraseña secreta que BotFather te da para tu bot. Queda cifrada en tu PC y nunca aparece en chats ni registros. |
| **`/tg`** | El comando que escribes dentro de una ventana de Pi para vincularla a tu teléfono (o desvincularla, con `/tg off`). |
| **Alias** | Un nombre legible que le ponés a una ventana de Pi desde el teléfono con `/alias <nombre>`, por ejemplo `Home PC`. Sirve sobre todo con varias ventanas del mismo proyecto. Sobrevive a reinicios del puente y a que la misma ventana se reconecte, pero no a cerrar la ventana y abrir una nueva. |
| **Ventana de Pi** | Una copia de Pi corriendo en una terminal. Puedes tener varias; cada una se vincula por separado. |
| **Sesión / workspace** | Una sesión es una ventana de Pi viva que el puente conoce; el workspace es la carpeta de proyecto en la que esa ventana trabaja. El nombre de esa carpeta se convierte en la etiqueta legible que ves en el teléfono, como `Pi · mi-proyecto`. |
| **La conexión de fondo** | Un programa pequeño que corre en silencio en tu PC y transporta mensajes entre Telegram y Pi. Está registrado como tarea programada de Windows, pero la configuración la registra deshabilitada y no la arranca: el modo Beginner nunca la habilita ni la arranca, y el modo avanzado te pregunta una vez al final y por defecto es No, así que no arranca nada al iniciar sesión si no la prendés vos: con `telegram on`, que la habilita y la arranca, o respondiendo que sí a esa única pregunta. Después la controlás vos: `telegram off` la detiene y la deshabilita, y una vez apagada sigue apagada después de reiniciar hasta que la prendés de nuevo. Se comunica con Telegram mediante long polling. |

## Saber más

- [README.md](README.md) — la guía completa en inglés, con la tabla de solución de problemas y el modelo de seguridad.
- [Advanced guide](docs/ADVANCED.md) — comandos, ciclo de vida, instalación manual y rollback.
- [Architecture](docs/ARCHITECTURE.md) — límites de confianza y flujo de datos.
