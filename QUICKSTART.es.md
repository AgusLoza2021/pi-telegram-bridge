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
7. Después de confirmar, la ventana instala un auxiliar dentro de Pi (queda inactivo hasta que tú vincules una ventana en el Paso 4), configura una conexión de fondo que arranca cada vez que inicias sesión en Windows, y la inicia.

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

## Los fallos más comunes

| Síntoma | Qué hacer |
|---|---|
| La configuración dice que necesita un Node.js más reciente (`This setup needs a newer Node.js...`) | Tienes Node.js 18 o 22. Instala la versión actual desde [https://nodejs.org](https://nodejs.org), cierra la ventana de configuración y ejecuta `Setup Pi Telegram.cmd` de nuevo. Nada quedó modificado en tu PC. |
| `'node' is not recognized` al verificar la versión | Node.js no está instalado. Instálalo desde [https://nodejs.org](https://nodejs.org) y, después, cierra y vuelve a abrir el Símbolo del sistema para que Windows reconozca el programa nuevo. |
| Hiciste doble clic en el archivo de configuración **desde dentro del ZIP** | Windows lo ejecuta desde una carpeta temporal que no tiene el resto de los archivos del proyecto, y la configuración puede avisarte de que falta algo que en realidad sí tienes. Cierra esa ventana, extrae el ZIP correctamente (clic derecho → **Extraer todo...**) y ejecuta `Setup Pi Telegram.cmd` desde la carpeta extraída. |
| El código QR expiró o no se puede escanear | Cierra la configuración y ejecuta `Setup Pi Telegram.cmd` de nuevo para obtener un código nuevo. Sube el brillo de la pantalla y acerca el teléfono. |
| El bot dice que no hay Pi conectado (`no Pi window is connected`) | Abre Pi en la PC, escribe `/tg` y elige **Connect**. |

Para más síntomas y soluciones, mira la sección [Fix problems del README](README.md#fix-problems).

## Mini glosario

| Palabra | Qué significa aquí |
|---|---|
| **Bot** | Una cuenta de Telegram manejada por un programa en lugar de una persona. Creas el tuyo con @BotFather y solo tú puedes hablar con él. |
| **Token** | La contraseña secreta que BotFather te da para tu bot. Queda cifrada en tu PC y nunca aparece en chats ni registros. |
| **`/tg`** | El comando que escribes dentro de una ventana de Pi para vincularla a tu teléfono (o desvincularla, con `/tg off`). |
| **Ventana de Pi** | Una copia de Pi corriendo en una terminal. Puedes tener varias; cada una se vincula por separado. |
| **Sesión / workspace** | Una sesión es una ventana de Pi viva que el puente conoce; el workspace es la carpeta de proyecto en la que esa ventana trabaja. El nombre de esa carpeta se convierte en la etiqueta legible que ves en el teléfono, como `Pi · mi-proyecto`. |
| **La conexión de fondo** | Un programa pequeño que corre en silencio en tu PC y transporta mensajes entre Telegram y Pi. Arranca cuando inicias sesión en Windows (está registrado como tarea programada de Windows y se comunica con Telegram mediante long polling). |

## Saber más

- [README.md](README.md) — la guía completa en inglés, con la tabla de solución de problemas y el modelo de seguridad.
- [Advanced guide](docs/ADVANCED.md) — comandos, ciclo de vida, instalación manual y rollback.
- [Architecture](docs/ARCHITECTURE.md) — límites de confianza y flujo de datos.
