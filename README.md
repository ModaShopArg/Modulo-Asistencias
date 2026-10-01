# Sistema de Sueldos + Módulo de Asistencias — MODASHOP

Dos tableros conectados a través de Firebase:

| Archivo | Para qué sirve | Quién lo usa |
|---|---|---|
| `index.html` | **Tablero interno**: directorio, liquidación de sueldos y premios, informes, control de asistencias y respaldo. | Administración |
| `asistencias.html` | **Módulo de Asistencias**: reloj con hora de Argentina; cada empleado elige su nombre y ficha entrada o salida con un PIN de 6 números. | Empleados, desde el equipo de la entrada |

Los fichajes del Módulo de Asistencias aparecen al instante en la sección **Asistencias** del tablero interno, y desde **Liquidar Sueldos → "Traer desde Asistencias"** se cargan las horas del período en la liquidación.

## Estructura

```
index.html            Tablero interno
asistencias.html      Módulo de Asistencias
js/datos.js           Conexión con Firebase y lógica compartida
js/firebase-config.js Datos del proyecto de Firebase (completar)
js/marca.js           Paleta de colores y tipografía del Manual de Marca
img/                  Logo e isologo oficiales (extraídos del Manual de Marca)
firestore.rules       Reglas de seguridad de la base de datos (completar emails)
```

## Identidad visual
Los dos tableros usan modo claro y la paleta del Manual de Marca, definida en `js/marca.js`:

| Color | Uso | Valor |
|---|---|---|
| Magenta 100% (Pantone Process Magenta C) | Color principal: botones, activos, acentos | `#E90089` |
| Negro 100% (Pantone Process Black) | Textos y títulos | `#231F20` |
| Negro 60% | Textos secundarios | `#818486` |
| Rosa claro | Fondos de apoyo | `#FFD7F1` |

Los tonos rosas y grises de todo el sistema se derivan de esos colores. Los colores de estado (verde para ingresos y marcas de entrada, rojo para descuentos y errores, ámbar para advertencias) se mantienen porque indican un significado.

La tipografía de apoyo de la marca es **Gotham Rounded**, que tiene licencia paga. Mientras tanto se usa **Nunito**, la alternativa libre más parecida. Si tienen la licencia web de Gotham Rounded, alcanza con cargarla en la página: `js/marca.js` ya la pone primera.

## Puesta en marcha

### 1. Crear el proyecto de Firebase
1. Entrá a <https://console.firebase.google.com> y creá un proyecto nuevo (Google Analytics no hace falta).
2. En **Configuración del proyecto → General → Tus apps**, agregá una app **Web** (`</>`). Copiá los valores de `firebaseConfig` y pegalos en `js/firebase-config.js`.

### 2. Crear las cuentas
En **Authentication → Método de acceso**, habilitá **Correo electrónico/contraseña**. Después, en **Usuarios → Agregar usuario**, creá dos cuentas:

- una de **administración** (por ejemplo `admin@tuempresa.com`), para entrar al tablero interno;
- una de **asistencias** (por ejemplo `asistencias@tuempresa.com`), para activar el equipo donde fichan los empleados.

Recomendado: en **Authentication → Configuración → Acciones del usuario**, desactivá la opción de que cualquiera pueda registrarse.

### 3. Crear la base de datos y sus reglas
1. En **Firestore Database → Crear base de datos**, elegí el **modo de producción** y la ubicación `southamerica-east1` (São Paulo).
2. Abrí `firestore.rules`, revisá que los emails de `esAdmin()` y `esKiosco()` sean los del paso 2, copiá todo el contenido en la pestaña **Reglas** y tocá **Publicar**.

### 4. Subir a GitHub y publicar
1. Creá un repositorio nuevo en GitHub.
2. Subí `index.html`, `asistencias.html`, `firestore.rules`, `README.md`, `.gitignore` y las carpetas `js/` e `img/`. Desde la web se hace con **Add file → Upload files**, arrastrando los archivos. **No subas la carpeta `original/`**: tiene la contraseña del sistema anterior escrita en el código.
3. En **Settings → Pages**, elegí **Deploy from a branch**, la rama `main` y la carpeta `/ (root)`. En unos minutos queda publicado en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.
4. En Firebase, en **Authentication → Configuración → Dominios autorizados**, agregá `TU-USUARIO.github.io`.

### 5. Primer uso
1. Entrá a la dirección publicada con la cuenta de administración.
2. Para traer los datos del sistema anterior, abrí el tablero viejo, andá a **Config. y Respaldo → Descargar Archivo .json** e importá ese archivo en **Config. y Respaldo** del tablero nuevo.
3. En **Directorio**, editá cada empleado y asignale su **PIN de 6 números**. Por seguridad, el PIN no se puede ver después: solo se puede reemplazar.
4. En el equipo donde fichan los empleados, abrí `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/asistencias.html` e ingresá **una sola vez** con la cuenta de asistencias. La sesión queda guardada. Para cerrarla, tocá 5 veces seguidas el logo.

### Pasar de un tablero al otro
- En el sistema interno, el botón **Módulo de Asistencias** del menú lateral abre el Módulo de Asistencias.
- En el Módulo de Asistencias, el botón **Sistema interno** solo aparece con la sesión de administración. Los empleados, que usan la cuenta de asistencias, no lo ven.
- Si en la pantalla de ingreso del Módulo de Asistencias se entra con la cuenta de administración, se abre directamente el sistema interno.
- Si en la pantalla de ingreso del sistema interno se entra con la cuenta de asistencias, se abre directamente el Módulo de Asistencias.

## Marcas con advertencia
El Módulo de Asistencias deja fichar entrada o salida en cualquier momento. En tres casos muestra primero una advertencia y pide confirmar:

- **Marca repetida:** pasaron menos de 2 minutos desde la marca anterior.
- **Entrada sin salida previa:** hay una entrada abierta.
- **Salida sin entrada:** no hay una entrada abierta.

Si el empleado confirma, la marca se guarda con una nota y en el sistema interno aparece con **⚠**. Al pasar el mouse, esa marca muestra el motivo. Con el teclado: Enter registra igual y Esc cancela.

## Frases motivadoras
Cada vez que alguien ficha, el Módulo de Asistencias muestra una frase al azar en un recuadro destacado: verde al entrar y magenta al salir. Las frases se cargan en **Config. y Respaldo → Frases Motivadoras** del sistema interno, en dos listas: entrada y salida. Si una frase incluye `{nombre}`, se reemplaza por el nombre del empleado. Mientras no cargues ninguna, se usan las frases predeterminadas. Con **Restaurar predeterminadas** se vuelve a ellas.

Las frases se guardan en Firebase, en la colección `configuracion`. Para que funcione, las reglas publicadas tienen que incluir el bloque `match /configuracion/{id}` de `firestore.rules`.

## Funcionamiento continuo del Módulo de Asistencias (24/7)
El módulo de asistencias está preparado para quedar abierto sin interrupciones:

- **Cortes de internet:** aparece un aviso arriba y la conexión con Firebase se recupera sola. Mientras no hay conexión, las marcas **no se registran** y se le avisa al empleado en el momento. Así ninguna marca se guarda después con la hora de la reconexión.
- **Si Firebase corta la conexión en vivo**, se vuelve a conectar sola cada 30 segundos. La sesión de asistencias no se cierra por un error pasajero.
- **Si la página se abre o se recarga sin internet**, muestra "Sin conexión a internet" y se abre sola cuando vuelve la conexión.
- **Si ocurre un error inesperado**, en lugar de quedar la pantalla en blanco muestra "Reiniciando el módulo..." y se recarga sola.
- **Todos los días a las 4 de la mañana** se recarga una vez, para liberar memoria y tomar las actualizaciones publicadas en GitHub. Solo lo hace si nadie está fichando y hay conexión.
- **Salvapantallas:** después de 10 minutos sin uso, el logo de MODASHOP rebota por la pantalla sobre fondo negro y cambia de color en cada rebote. Al mover el mouse, hacer clic, tocar la pantalla o apretar una tecla, vuelve el módulo listo para fichar. La tecla que despierta no se toma como parte del PIN. Para probarlo sin esperar, abrí `asistencias.html?reposo=15`: aparece a los 15 segundos.
- **La pantalla no se apaga** mientras el módulo está abierto (cuando el navegador lo permite, como en Chrome y Edge con la dirección publicada).
- Las librerías externas se cargan con **versiones fijas**, así una versión nueva publicada en internet no puede romper el Módulo de Asistencias.

El tiempo trabajado se calcula con la hora de la entrada guardada en Firebase. Por eso sigue siendo correcto aunque el equipo se quede sin internet o se reinicie: al volver, el Módulo de Asistencias y el sistema interno muestran "Trabajando · desde 08:00 · 3h 20m".

### Si no se pudo fichar
En **Asistencias → Jornadas** del sistema interno:
- **Editar** en una jornada corrige la entrada o la salida, o completa la que falta. La hora original queda registrada: la marca aparece con **(E)** y, al pasar el mouse, muestra la hora original.
- **+ Cargar Jornada** carga una jornada entera para alguien que no pudo fichar. Si todavía está trabajando, se deja la salida vacía: el Módulo de Asistencias lo muestra trabajando y después puede fichar la salida normalmente.
- Una jornada no puede superar las 16 horas. Si alguien sale después de medianoche, se cambia la fecha de salida.

Recomendaciones para la computadora del Módulo de Asistencias:
- En Windows, en **Configuración → Sistema → Inicio/apagado y suspensión**, poné la suspensión en **Nunca**.
- En **Windows Update → Opciones avanzadas**, configurá el **horario de actividad** para que los reinicios por actualizaciones no ocurran en horario laboral.
- Para que el módulo se abra solo al encender o reiniciar la PC, creá un acceso directo de Chrome con `--kiosk https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/asistencias.html` y ponelo en la carpeta de inicio (`Win + R` → `shell:startup`). El modo `--kiosk` abre la página en pantalla completa; se sale con `Alt + F4`.

## Seguridad
- Los valores de `js/firebase-config.js` no son secretos: Firebase los expone en cualquier app web. Lo que protege los datos son las cuentas y las reglas de `firestore.rules`.
- La cuenta de asistencias **no puede ver sueldos ni liquidaciones**. Solo lee nombre, puesto y PIN cifrado de cada empleado, lee las marcas y crea marcas nuevas. No puede modificar ni borrar marcas.
- La hora de cada fichaje la pone el **servidor de Firebase**, así que no se puede adulterar cambiando el reloj del equipo donde se ficha.
- Después de 5 PIN incorrectos, se bloquea a ese empleado durante 5 minutos en ese equipo.
- El PIN se valida en el equipo donde se ficha. Por eso, la cuenta de asistencias tiene que usarse solo en ese equipo.

## Probarlo en la computadora
Los archivos no funcionan con doble clic, porque `js/datos.js` es un módulo. Levantá un servidor local:

```bash
python -m http.server 8765
```

Después abrí `http://localhost:8765/`. `localhost` ya viene autorizado en Firebase.
