# Horda Neón

Juego de supervivencia contra hordas (estilo *Vampire Survivors*) con estética de neón, hecho solo con HTML, CSS y JavaScript, sin librerías ni instalación. Todo se dibuja con Canvas 2D, y la música y los sonidos se generan en tiempo real con Web Audio.

Sobrevive 10 minutos, sube de nivel, combina armas y mejoras, haz evolucionar tus armas y derrota al **Núcleo del Vacío**.

## Cómo jugar

### En el ordenador
Abre `index.html` con doble clic. Se abre en el navegador (Chrome, Edge, Firefox…).

- **Moverse:** `WASD` o flechas
- **Las armas disparan solas.** Recoge los cristales para subir de nivel y elegir mejoras (`1`, `2`, `3` o clic).
- **Pausa:** `P` · **Música:** `M`

### En el móvil
1. En el ordenador, haz doble clic en `JUGAR-EN-MOVIL.bat` (necesita [Node.js](https://nodejs.org)).
2. Si Windows pregunta por el Firewall, pulsa **Permitir acceso**.
3. Con el móvil en el **mismo Wi-Fi**, abre en el navegador la dirección que aparece (por ejemplo `http://192.168.1.59:8080`).

En el móvil te mueves arrastrando el dedo por la pantalla (joystick flotante). Desde el menú del navegador puedes usar "Añadir a pantalla de inicio" para tenerlo como una app.

## Contenido

- **7 armas** con evolución: Pulso Neón, Orbes Gemelos, Arco Voltaico, Onda Nova, Disco Cuántico, Lluvia Estelar y Drones Escolta.
- **9 mejoras pasivas.**
- **4 jefes** con patrones de ataque distintos, más hordas que te rodean y estampidas.
- **Récord** guardado en el navegador.

## Imágenes personalizadas

Pon imágenes en la carpeta `imagenes/` con estos nombres y se usarán en lugar de los dibujos de neón:

| Archivo | Personaje |
|---|---|
| `zangano.png` | Enemigo básico |
| `veloz.png` | Enemigo rápido |
| `divisor.png` | Se divide en tres al morir |
| `mini.png` | Los trozos del divisor |
| `centinela.png` | Enemigo que dispara |
| `tanque.png` | Enemigo grande y resistente |
| `jefe1.png` … `jefe4.png` | Los 4 jefes (el 4 es el jefe final) |
| `jugador.png` | Tu personaje |

En `juego.js`, la lista `SKINS` permite elegir para cada imagen:
- `modo: 'recorte'`: para imágenes con fondo transparente (silueta con brillo de neón).
- `modo: 'circulo'`: para fotos con fondo (recortadas en un círculo).
- `tam`: el tamaño (por ejemplo `1.3` para que sea un 30% más grande).

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La página del juego |
| `estilo.css` | Menús, HUD y pantallas |
| `juego.js` | Todo el juego (comentado en español) |
| `servidor-movil.js` / `JUGAR-EN-MOVIL.bat` | Servidor para jugar desde el móvil en tu Wi-Fi |
| `manifest.json` / `icono.svg` | Icono y modo "app" en el móvil |
| `imagenes/` | Imágenes personalizadas |
