// Capa de datos compartida entre el tablero interno (index.html) y el
// módulo de asistencias (asistencias.html), conectada a Firebase.
//
// Colecciones de Firestore:
//   empleados/{id}        -> ficha completa con sueldos (solo administración)
//   empleadosKiosco/{id}  -> nombre, puesto y hash del PIN (lo lee el kiosco)
//   historial/{id}        -> liquidaciones y recibos (solo administración)
//   fichajes/{autoId}     -> entradas y salidas (la cuenta de asistencias solo puede crear)
//
// Los permisos se definen en firestore.rules.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, doc, setDoc, deleteDoc, updateDoc, addDoc, getDocs,
    onSnapshot, query, where, orderBy, limit, writeBatch, runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const ZONA_AR = 'America/Argentina/Buenos_Aires';
const MAX_INTENTOS_PIN = 5;
const BLOQUEO_MS = 5 * 60 * 1000;
const JORNADA_MAX_MS = 16 * 60 * 60 * 1000; // una entrada sin salida más vieja que esto se considera olvidada
const CLAVE_BLOQUEOS = 'modashop.bloqueosPin';

const config = window.FIREBASE_CONFIG;
const configurado = !!(config && config.apiKey && !String(config.apiKey).startsWith('COMPLETAR'));

let auth = null;
let db = null;
if (configurado) {
    const app = initializeApp(config);
    auth = getAuth(app);
    // Caché en disco (IndexedDB): la lista de empleados y los fichajes recientes quedan
    // guardados en el equipo, así el módulo abre al instante y sigue mostrando los datos
    // aunque se reinicie la PC sin internet. persistentMultipleTabManager coordina la caché
    // si llegara a haber más de una pestaña abierta. Si el navegador no permite IndexedDB
    // (modo privado, equipo viejo), se cae a la caché en memoria sin romper el módulo.
    try {
        db = initializeFirestore(app, {
            localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        });
    } catch (e) {
        console.warn('No se pudo activar la caché en disco; se usa la de memoria.', e);
        db = getFirestore(app);
    }
}

// ---------- Sesión ----------

const escucharSesion = (callback) => onAuthStateChanged(auth, callback);
const iniciarSesion = (email, password) => signInWithEmailAndPassword(auth, email.trim(), password);
const cerrarSesion = () => signOut(auth);

// Cambia la contraseña de la cuenta que está conectada en este momento. Se vuelve a pedir la
// contraseña actual (Firebase lo exige si la sesión es vieja, y además confirma que quien la
// cambia la conoce). La contraseña nunca se guarda en el código ni en la base: la maneja Firebase.
const cambiarPassword = async (passwordActual, passwordNueva) => {
    const u = auth && auth.currentUser;
    if (!u) throw { code: 'sin-sesion' };
    const cred = EmailAuthProvider.credential(u.email, passwordActual);
    await reauthenticateWithCredential(u, cred);
    await updatePassword(u, passwordNueva);
};

// Envía un correo para restablecer la contraseña de una cuenta (sirve si se la olvidaron).
const enviarResetPassword = (email) => sendPasswordResetEmail(auth, email.trim());

const emailActual = () => (auth && auth.currentUser && auth.currentUser.email) || '';

// Las reglas solo dejan leer `empleados` a la cuenta de administración, así que
// alcanza con intentar leer uno para saber qué cuenta está conectada.
const esAdministrador = async () => {
    if (!auth || !auth.currentUser) return false;
    try {
        await getDocs(query(collection(db, 'empleados'), limit(1)));
        return true;
    } catch (e) {
        return false;
    }
};

// La cuenta del kiosco (y la de administración) pueden leer `empleadosKiosco`.
const puedeUsarKiosco = async () => {
    if (!auth || !auth.currentUser) return false;
    try {
        await getDocs(query(collection(db, 'empleadosKiosco'), limit(1)));
        return true;
    } catch (e) {
        return false;
    }
};

const errorAmigable = (error) => {
    const codigo = (error && error.code) || '';
    if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(codigo)) return 'Email o contraseña incorrectos.';
    if (codigo === 'auth/too-many-requests') return 'Demasiados intentos. Esperá unos minutos y probá de nuevo.';
    if (codigo === 'auth/weak-password') return 'La contraseña nueva es muy corta: tiene que tener al menos 6 caracteres.';
    if (codigo === 'auth/requires-recent-login') return 'Por seguridad, cerrá sesión, volvé a entrar y cambiala de nuevo.';
    if (codigo === 'auth/network-request-failed' || codigo === 'unavailable') return 'Sin conexión a internet.';
    if (codigo === 'permission-denied') return 'Esta cuenta no tiene permiso para esta acción.';
    return (error && error.message) || 'Error desconocido.';
};

// ---------- Hora argentina ----------

// Diferencia entre el reloj del equipo y el del servidor que sirve la página,
// para que el reloj del kiosco muestre la hora correcta aunque la PC esté desfasada.
let desfaseMs = 0;
const sincronizarHora = async () => {
    try {
        const t0 = Date.now();
        const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
        const t1 = Date.now();
        const fechaServidor = res.headers.get('Date');
        if (fechaServidor) desfaseMs = Date.parse(fechaServidor) + 500 - (t0 + t1) / 2;
    } catch (e) {
        // sin conexión: se mantiene el último ajuste conocido
    }
    return desfaseMs;
};
const ahora = () => Date.now() + desfaseMs;

const formateadorAR = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA_AR, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

// Devuelve { fecha: 'YYYY-MM-DD', hora: 'HH:MM:SS' } en horario de Argentina,
// sin importar la zona horaria configurada en el equipo.
const partesAR = (momento = new Date(ahora())) => {
    const p = {};
    formateadorAR.formatToParts(momento).forEach(x => { p[x.type] = x.value; });
    const hora = p.hour === '24' ? '00' : p.hour;
    return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${hora}:${p.minute}:${p.second}` };
};

// Argentina usa UTC-3 fijo (sin horario de verano).
const timestampDesdeAR = (fecha, hora = '00:00') => {
    const h = hora.length === 5 ? hora + ':00' : hora;
    return new Date(`${fecha}T${h}-03:00`).getTime();
};

const fechaLarga = (momento = new Date(ahora())) => {
    const texto = new Intl.DateTimeFormat('es-AR', { timeZone: ZONA_AR, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(momento);
    return texto.charAt(0).toUpperCase() + texto.slice(1);
};

const fechaCorta = (fechaISO) => {
    const [a, m, d] = fechaISO.split('-');
    return `${d}/${m}/${a}`;
};

const formatearHoras = (horas) => {
    const totalMin = Math.round(horas * 60);
    return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`;
};

// ---------- PIN ----------

// SHA-256 en JS puro (funciona igual en http y https).
const sha256 = (texto) => {
    const rotar = (v, n) => (v >>> n) | (v << (32 - n));
    const maxWord = Math.pow(2, 32);
    const h = [], k = [];
    const compuesto = {};
    for (let cand = 2, n = 0; n < 64; cand++) {
        if (!compuesto[cand]) {
            for (let i = 0; i < 313; i += cand) compuesto[i] = cand;
            h[n] = (Math.pow(cand, 0.5) * maxWord) | 0;
            k[n++] = (Math.pow(cand, 1 / 3) * maxWord) | 0;
        }
    }
    let ascii = unescape(encodeURIComponent(texto));
    const bitLength = ascii.length * 8;
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    const words = [];
    for (let i = 0; i < ascii.length; i++) words[i >> 2] |= ascii.charCodeAt(i) << ((3 - i) % 4) * 8;
    words[words.length] = (bitLength / maxWord) | 0;
    words[words.length] = bitLength;
    let hash = h.slice(0, 8);
    for (let j = 0; j < words.length;) {
        const w = words.slice(j, j += 16);
        const anterior = hash;
        hash = hash.slice(0, 8);
        for (let i = 0; i < 64; i++) {
            const w15 = w[i - 15], w2 = w[i - 2];
            const a = hash[0], e = hash[4];
            const t1 = hash[7]
                + (rotar(e, 6) ^ rotar(e, 11) ^ rotar(e, 25))
                + ((e & hash[5]) ^ ((~e) & hash[6]))
                + k[i]
                + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rotar(w15, 7) ^ rotar(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rotar(w2, 17) ^ rotar(w2, 19) ^ (w2 >>> 10))) | 0);
            const t2 = (rotar(a, 2) ^ rotar(a, 13) ^ rotar(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
            hash = [(t1 + t2) | 0].concat(hash);
            hash[4] = (hash[4] + t1) | 0;
        }
        for (let i = 0; i < 8; i++) hash[i] = (hash[i] + anterior[i]) | 0;
    }
    let res = '';
    for (let i = 0; i < 8; i++) {
        for (let j = 3; j >= 0; j--) {
            const b = (hash[i] >> (j * 8)) & 255;
            res += (b < 16 ? '0' : '') + b.toString(16);
        }
    }
    return res;
};

const esPinValido = (pin) => /^\d{6}$/.test(pin);
const hashPin = (empleadoId, pin) => sha256(`modashop:${empleadoId}:${pin}`);

const leerBloqueos = () => {
    try { return JSON.parse(localStorage.getItem(CLAVE_BLOQUEOS)) || {}; } catch (e) { return {}; }
};
const guardarBloqueos = (b) => {
    try { localStorage.setItem(CLAVE_BLOQUEOS, JSON.stringify(b)); } catch (e) { /* sin almacenamiento local */ }
};

// Valida el PIN contra la ficha del kiosco. Los intentos fallidos se cuentan en este dispositivo.
// Devuelve { ok, motivo, intentosRestantes, bloqueadoHasta }
const verificarPin = (empleado, pin) => {
    if (!empleado || !empleado.pinHash) return { ok: false, motivo: 'sin-pin' };

    const bloqueos = leerBloqueos();
    const estado = bloqueos[empleado.id] || { intentos: 0, hasta: 0 };
    if (estado.hasta > Date.now()) return { ok: false, motivo: 'bloqueado', bloqueadoHasta: estado.hasta };

    if (hashPin(empleado.id, pin) === empleado.pinHash) {
        delete bloqueos[empleado.id];
        guardarBloqueos(bloqueos);
        return { ok: true };
    }

    const intentos = (estado.hasta && estado.hasta <= Date.now() ? 0 : estado.intentos) + 1;
    if (intentos >= MAX_INTENTOS_PIN) {
        bloqueos[empleado.id] = { intentos: 0, hasta: Date.now() + BLOQUEO_MS };
        guardarBloqueos(bloqueos);
        return { ok: false, motivo: 'bloqueado', bloqueadoHasta: bloqueos[empleado.id].hasta };
    }
    bloqueos[empleado.id] = { intentos, hasta: 0 };
    guardarBloqueos(bloqueos);
    return { ok: false, motivo: 'incorrecto', intentosRestantes: MAX_INTENTOS_PIN - intentos };
};

// ---------- Empleados ----------

const listaDesdeSnapshot = (snap) => {
    const lista = [];
    snap.forEach(d => lista.push(d.data()));
    return lista;
};

const escucharEmpleados = (callback, onError) =>
    onSnapshot(collection(db, 'empleados'), snap => callback(listaDesdeSnapshot(snap).sort((a, b) => a.id - b.id)), onError);

// El segundo parámetro del callback indica si hay conexión con Firebase: cuando se corta,
// Firestore sigue entregando los datos guardados pero marcados como `fromCache`.
const escucharEmpleadosKiosco = (callback, onError) =>
    onSnapshot(collection(db, 'empleadosKiosco'), { includeMetadataChanges: true },
        snap => callback(listaDesdeSnapshot(snap), !snap.metadata.fromCache), onError);

const fichaKiosco = (emp, pinHash) => ({
    id: emp.id,
    nombre: emp.nombre || '',
    puesto: emp.puesto || '',
    ...(pinHash ? { pinHash } : {})
});

// pinNuevo es opcional: si viene, reemplaza el PIN actual.
const guardarEmpleado = async (emp, pinNuevo) => {
    const { firebaseId, pinHash: _viejo, ...datos } = emp;
    const pinHash = pinNuevo ? hashPin(emp.id, pinNuevo) : null;
    const batch = writeBatch(db);
    batch.set(doc(db, 'empleados', String(emp.id)), { ...datos, tienePin: !!(pinHash || emp.tienePin) });
    batch.set(doc(db, 'empleadosKiosco', String(emp.id)), fichaKiosco(emp, pinHash), { merge: true });
    await batch.commit();
};

const eliminarEmpleado = async (id) => {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'empleados', String(id)));
    batch.delete(doc(db, 'empleadosKiosco', String(id)));
    await batch.commit();
};

// ---------- Liquidaciones ----------

const escucharHistorial = (callback, onError) =>
    onSnapshot(collection(db, 'historial'), snap => callback(listaDesdeSnapshot(snap)), onError);

const guardarLiquidacion = (registro) => {
    const { firebaseId, ...datos } = registro;
    return setDoc(doc(db, 'historial', String(registro.idGuardado)), JSON.parse(JSON.stringify(datos)));
};

const eliminarLiquidacion = (idGuardado) => deleteDoc(doc(db, 'historial', String(idGuardado)));

const actualizarNota = (idGuardado, nota) => updateDoc(doc(db, 'historial', String(idGuardado)), { observacion: nota });

// ---------- Fichajes ----------

const normalizarFichaje = (d) => {
    const data = d.data({ serverTimestamps: 'estimate' });
    const ts = data.timestamp ? data.timestamp.toMillis() : ahora();
    const { fecha, hora } = partesAR(new Date(ts));
    return {
        id: d.id,
        empleadoId: data.empleadoId,
        empleadoNombre: data.empleadoNombre || '',
        tipo: data.tipo,
        timestamp: ts,
        fecha,
        hora,
        origen: data.origen || 'kiosco',
        nota: data.nota || '',
        editado: !!data.editado,
        timestampOriginal: data.timestampOriginal ? data.timestampOriginal.toMillis() : null,
        registradoEn: data.registradoEn ? data.registradoEn.toMillis() : null, // cuándo llegó a Firebase
        pendiente: d.metadata ? d.metadata.hasPendingWrites : false
    };
};

const consultaFichajes = ({ desde, hasta } = {}) => {
    const filtros = [];
    if (desde) filtros.push(where('timestamp', '>=', Timestamp.fromMillis(desde)));
    if (hasta) filtros.push(where('timestamp', '<=', Timestamp.fromMillis(hasta)));
    return query(collection(db, 'fichajes'), ...filtros, orderBy('timestamp'));
};

// desde / hasta en milisegundos (opcionales)
const escucharFichajes = (rango, callback, onError) =>
    onSnapshot(consultaFichajes(rango), snap => {
        const lista = [];
        snap.forEach(d => lista.push(normalizarFichaje(d)));
        callback(lista);
    }, onError);

const obtenerFichajes = async (rango) => {
    const snap = await getDocs(consultaFichajes(rango));
    const lista = [];
    snap.forEach(d => lista.push(normalizarFichaje(d)));
    return lista;
};

// Identificador para una marca nueva. Se genera en el equipo antes de enviarla, así los
// reintentos usan siempre el mismo y una marca nunca se guarda dos veces.
const nuevoIdFichaje = () => doc(collection(db, 'fichajes')).id;

// Cargas manuales del sistema interno: usan la hora indicada.
const registrarFichaje = ({ empleadoId, empleadoNombre, tipo, timestamp, origen = 'manual', nota = '' }) =>
    addDoc(collection(db, 'fichajes'), { empleadoId, empleadoNombre: empleadoNombre || '', tipo, origen, nota, timestamp: Timestamp.fromMillis(timestamp) });

// Envía a Firebase una marca del Módulo de Asistencias. La hora es la del momento en que el
// empleado fichó (reloj ajustado a la hora oficial), y `registradoEn` la pone el servidor al
// recibirla. Es una transacción: si la marca con ese id ya existe (un envío anterior que sí
// llegó), no se escribe de nuevo.
const enviarMarca = async (m) => {
    const ref = doc(db, 'fichajes', m.id);
    const datos = { empleadoId: m.empleadoId, empleadoNombre: m.empleadoNombre || '', tipo: m.tipo, origen: 'kiosco', nota: m.nota || '' };
    const escribir = (conHoraDelEquipo) => runTransaction(db, async (t) => {
        const previa = await t.get(ref);
        if (previa.exists()) return;
        t.set(ref, conHoraDelEquipo
            ? { ...datos, timestamp: Timestamp.fromMillis(m.timestamp), registradoEn: serverTimestamp() }
            : { ...datos, timestamp: serverTimestamp() });
    });
    try {
        await escribir(true);
    } catch (e) {
        // Si las reglas publicadas todavía son las anteriores (solo aceptan la hora del servidor),
        // una marca recién hecha se envía con ese formato. Las más viejas esperan a las reglas nuevas.
        if (e.code === 'permission-denied' && ahora() - m.timestamp < 2 * 60 * 1000) return escribir(false);
        throw e;
    }
};

// ---------- Marcas pendientes de envío ----------
// Cada marca se guarda primero en este equipo (localStorage) y se envía en segundo plano,
// reintentando hasta que Firebase la confirma. Así un corte de internet o una conexión lenta
// nunca impiden fichar, y las marcas sobreviven a una recarga o un reinicio de la PC.

const CLAVE_PENDIENTES = 'modashop.marcasPendientes';
const ESPERA_ENVIO_MS = 20000;
let pendientesEnMemoria = []; // respaldo si el navegador no deja usar localStorage

const leerPendientes = () => {
    try {
        const texto = localStorage.getItem(CLAVE_PENDIENTES);
        return texto ? JSON.parse(texto) : [];
    } catch (e) {
        return pendientesEnMemoria;
    }
};
const guardarPendientes = (lista) => {
    pendientesEnMemoria = lista;
    try { localStorage.setItem(CLAVE_PENDIENTES, JSON.stringify(lista)); } catch (e) { /* queda en memoria */ }
    window.dispatchEvent(new Event('marcas-pendientes'));
};

// Avisa cada vez que cambia la lista (también si cambia en otra pestaña del mismo equipo)
const escucharPendientes = (callback) => {
    const avisar = () => callback(leerPendientes());
    const porOtraPestana = (e) => { if (e.key === CLAVE_PENDIENTES) avisar(); };
    window.addEventListener('marcas-pendientes', avisar);
    window.addEventListener('storage', porOtraPestana);
    avisar();
    return () => {
        window.removeEventListener('marcas-pendientes', avisar);
        window.removeEventListener('storage', porOtraPestana);
    };
};

let enviando = false;
const enviarPendientes = async () => {
    if (enviando || !auth || !auth.currentUser) return;
    enviando = true;
    try {
        for (const m of leerPendientes()) {
            try {
                // Si el envío llega después de agotada la espera, igual se quita de la lista
                const envio = enviarMarca(m).then(() => guardarPendientes(leerPendientes().filter(p => p.id !== m.id)));
                envio.catch(() => {}); // si falla tarde, se reintenta en la próxima vuelta
                await Promise.race([
                    envio,
                    new Promise((_, rechazar) => setTimeout(() => rechazar({ code: 'tiempo-agotado' }), ESPERA_ENVIO_MS))
                ]);
            } catch (e) {
                console.warn('Marca pendiente sin enviar todavía:', m.id, e.code || e);
                guardarPendientes(leerPendientes().map(p => p.id === m.id ? { ...p, intentos: (p.intentos || 0) + 1, ultimoError: e.code || 'error' } : p));
            }
        }
    } finally {
        enviando = false;
    }
};

// Registra la marca en el equipo al instante y la manda a Firebase en segundo plano.
// Devuelve la marca tal como se va a guardar.
const registrarMarca = ({ empleadoId, empleadoNombre, tipo, nota = '' }) => {
    const marca = { id: nuevoIdFichaje(), empleadoId, empleadoNombre: empleadoNombre || '', tipo, nota, timestamp: Math.round(ahora()) };
    guardarPendientes([...leerPendientes(), marca]);
    enviarPendientes();
    return marca;
};

// Reintenta solo: cada 15 segundos y apenas vuelve la red
setInterval(enviarPendientes, 15000);
window.addEventListener('online', () => enviarPendientes());

const eliminarFichaje = (id) => deleteDoc(doc(db, 'fichajes', id));

// Corrige o carga una jornada completa desde el tablero interno (por ejemplo, si se cortó
// internet y no se pudo fichar). Todo se guarda junto o no se guarda nada.
//   entrada / salida: el fichaje existente (o null si falta)
//   entradaTs / salidaTs: la hora correcta en ms (salidaTs null = no tocar la salida)
// Al corregir una marca se guarda la hora original la primera vez, para que quede registro.
const guardarJornada = async ({ empleadoId, empleadoNombre, entrada, salida, entradaTs, salidaTs, nota = '' }) => {
    const batch = writeBatch(db);
    const escribir = (existente, tipo, ts) => {
        if (existente) {
            if (existente.timestamp === ts && (!nota || existente.nota === nota)) return;
            const cambios = { timestamp: Timestamp.fromMillis(ts), editado: true };
            if (nota) cambios.nota = nota;
            if (!existente.timestampOriginal && existente.timestamp !== ts) cambios.timestampOriginal = Timestamp.fromMillis(existente.timestamp);
            batch.update(doc(db, 'fichajes', existente.id), cambios);
        } else {
            batch.set(doc(collection(db, 'fichajes')), {
                empleadoId, empleadoNombre: empleadoNombre || '', tipo, origen: 'manual', nota,
                timestamp: Timestamp.fromMillis(ts)
            });
        }
    };
    escribir(entrada, 'entrada', entradaTs);
    if (salidaTs) escribir(salida, 'salida', salidaTs);
    await batch.commit();
};

const ultimoFichaje = (empleadoId, fichajes) =>
    fichajes.filter(f => f.empleadoId === empleadoId).sort((a, b) => b.timestamp - a.timestamp)[0] || null;

// Si la última marca es una entrada reciente, lo que corresponde es la salida.
const proximoTipo = (empleadoId, fichajes) => {
    const ultimo = ultimoFichaje(empleadoId, fichajes);
    return ultimo && ultimo.tipo === 'entrada' && ahora() - ultimo.timestamp < JORNADA_MAX_MS ? 'salida' : 'entrada';
};

const estaPresente = (empleadoId, fichajes) => proximoTipo(empleadoId, fichajes) === 'salida';

// Arma jornadas emparejando entrada -> salida en orden cronológico por empleado.
// Devuelve [{ empleadoId, empleadoNombre, fecha, entrada, salida, horas, completa, enCurso }]
const calcularJornadas = (fichajes) => {
    const porEmpleado = {};
    fichajes.forEach(f => { (porEmpleado[f.empleadoId] = porEmpleado[f.empleadoId] || []).push(f); });

    const jornadas = [];
    Object.values(porEmpleado).forEach(lista => {
        lista.sort((a, b) => a.timestamp - b.timestamp);
        let abierta = null;
        lista.forEach(f => {
            if (f.tipo === 'entrada') {
                if (abierta) jornadas.push({ ...abierta, salida: null, horas: 0, completa: false });
                abierta = { empleadoId: f.empleadoId, empleadoNombre: f.empleadoNombre, fecha: f.fecha, entrada: f };
            } else if (abierta && f.timestamp - abierta.entrada.timestamp < JORNADA_MAX_MS) {
                const horas = (f.timestamp - abierta.entrada.timestamp) / 3600000;
                jornadas.push({ ...abierta, salida: f, horas, completa: true });
                abierta = null;
            } else {
                if (abierta) jornadas.push({ ...abierta, salida: null, horas: 0, completa: false });
                abierta = null;
                jornadas.push({ empleadoId: f.empleadoId, empleadoNombre: f.empleadoNombre, fecha: f.fecha, entrada: null, salida: f, horas: 0, completa: false });
            }
        });
        if (abierta) jornadas.push({ ...abierta, salida: null, horas: 0, completa: false, enCurso: ahora() - abierta.entrada.timestamp < JORNADA_MAX_MS });
    });
    return jornadas.sort((a, b) => (b.entrada || b.salida).timestamp - (a.entrada || a.salida).timestamp);
};

// 'Agosto 2026' + '1ra Quincena' -> { desde: '2026-08-01', hasta: '2026-08-15' }
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const rangoDePeriodo = (periodo, tipoLiquidacion) => {
    const partes = (periodo || '').toLowerCase().trim().split(/\s+/);
    if (partes.length < 2) return null;
    const mes = MESES.indexOf(partes[0].replace('setiembre', 'septiembre')) + 1;
    const anio = parseInt(partes[1]);
    if (!mes || !anio) return null;
    const mm = String(mes).padStart(2, '0');
    const ultimoDia = new Date(anio, mes, 0).getDate();
    if (tipoLiquidacion === '1ra Quincena') return { desde: `${anio}-${mm}-01`, hasta: `${anio}-${mm}-15` };
    if (tipoLiquidacion === '2da Quincena') return { desde: `${anio}-${mm}-16`, hasta: `${anio}-${mm}-${ultimoDia}` };
    return { desde: `${anio}-${mm}-01`, hasta: `${anio}-${mm}-${ultimoDia}` };
};

// Rango de días (YYYY-MM-DD, inclusive) en milisegundos, en horario argentino
const rangoEnMs = (desde, hasta) => ({
    desde: timestampDesdeAR(desde, '00:00:00'),
    hasta: timestampDesdeAR(hasta, '23:59:59') + 999
});

// ---------- Frases motivadoras ----------
// Se muestran en el kiosco al fichar. Se cargan desde Configuración del sistema interno
// y se guardan en configuracion/frases. "{nombre}" se reemplaza por el nombre del empleado.

const FRASES_PREDETERMINADAS = {
    entrada: [
        '¡Hoy es un gran día para dar lo mejor de vos, {nombre}!',
        'Tu actitud hace la diferencia. ¡A brillar!',
        'Cada cliente que atendés se lleva algo de tu energía. ¡Que sea de la buena!',
        'Hoy es una nueva oportunidad para superarte.',
        'Cada pequeño esfuerzo de hoy suma para el gran resultado de mañana.',
        '¡Arrancamos con todo, {nombre}! El equipo cuenta con vos.'
    ],
    salida: [
        '¡Gracias por tu esfuerzo de hoy, {nombre}! Descansá, te lo ganaste.',
        'Un día más sumando. ¡Estamos orgullosos de tu trabajo!',
        'Lo que hiciste hoy construye lo que logramos mañana. ¡Gracias!',
        'Desconectá, disfrutá y recargá energías. ¡Hasta la próxima!',
        'Tu dedicación se nota. ¡Buen descanso, {nombre}!'
    ]
};

// Normaliza cada frase a { texto, empleadoId }. Acepta el formato viejo (texto suelto):
// en ese caso queda "para todos". empleadoId '' = cualquier empleado; si no, el id (número) del empleado.
const limpiarFrases = (lista) => (Array.isArray(lista) ? lista : []).map(f => {
    const texto = String((typeof f === 'string' ? f : (f && f.texto)) ?? '').trim();
    let empleadoId = '';
    if (f && typeof f === 'object' && f.empleadoId !== '' && f.empleadoId != null) {
        const n = Number(f.empleadoId);
        empleadoId = Number.isFinite(n) ? n : '';
    }
    return { texto, empleadoId };
}).filter(f => f.texto);

// callback({ entrada, salida, personalizadas }): si todavía no se cargaron frases, usa las predeterminadas
const escucharFrases = (callback, onError) =>
    onSnapshot(doc(db, 'configuracion', 'frases'), snap => {
        const d = snap.exists() ? snap.data() : null;
        callback({
            entrada: limpiarFrases(d ? d.entrada : FRASES_PREDETERMINADAS.entrada),
            salida: limpiarFrases(d ? d.salida : FRASES_PREDETERMINADAS.salida),
            personalizadas: !!d
        });
    }, onError);

const guardarFrases = ({ entrada, salida }) =>
    setDoc(doc(db, 'configuracion', 'frases'), { entrada: limpiarFrases(entrada), salida: limpiarFrases(salida) });

const restaurarFrases = () => deleteDoc(doc(db, 'configuracion', 'frases'));

// ---------- Respaldo ----------

// Sube un respaldo .json (también acepta los exportados por el sistema anterior).
const importarRespaldo = async ({ empleados = [], historial = [], fichajes = [] }) => {
    const escrituras = [];
    empleados.forEach(emp => {
        const { firebaseId, pinHash, ...datos } = emp;
        escrituras.push(b => b.set(doc(db, 'empleados', String(emp.id)), { ...datos, tienePin: !!(pinHash || emp.tienePin) }));
        escrituras.push(b => b.set(doc(db, 'empleadosKiosco', String(emp.id)), fichaKiosco(emp, pinHash), { merge: true }));
    });
    historial.forEach(h => {
        const { firebaseId, ...datos } = h;
        escrituras.push(b => b.set(doc(db, 'historial', String(h.idGuardado)), JSON.parse(JSON.stringify(datos))));
    });
    fichajes.forEach(f => {
        escrituras.push(b => b.set(doc(db, 'fichajes', String(f.id)), {
            empleadoId: f.empleadoId,
            empleadoNombre: f.empleadoNombre || '',
            tipo: f.tipo,
            origen: f.origen || 'kiosco',
            nota: f.nota || '',
            timestamp: Timestamp.fromMillis(f.timestamp),
            ...(f.editado ? { editado: true } : {}),
            ...(f.timestampOriginal ? { timestampOriginal: Timestamp.fromMillis(f.timestampOriginal) } : {}),
            ...(f.registradoEn ? { registradoEn: Timestamp.fromMillis(f.registradoEn) } : {})
        }));
    });
    // Firestore admite hasta 500 escrituras por lote
    for (let i = 0; i < escrituras.length; i += 400) {
        const batch = writeBatch(db);
        escrituras.slice(i, i + 400).forEach(fn => fn(batch));
        await batch.commit();
    }
    return escrituras.length;
};

// ---------- Grupos y horarios (para el informe de dirección) ----------
// Se guardan en configuracion/horarios. "arriba" = empleados de arriba (un turno);
// "local" = empleados del local (turno partido). Cada empleado se asigna a un grupo.
// Los horarios son editables porque cambian según la época del año.
const HORARIOS_PREDETERMINADOS = {
    toleranciaMin: 15,
    grupos: {
        arriba: { nombre: 'Arriba', turnos: [{ entrada: '07:30', salida: '17:00' }] },
        local:  { nombre: 'Local',  turnos: [{ entrada: '08:00', salida: '12:30' }, { entrada: '16:30', salida: '20:30' }] }
    },
    asignaciones: {} // { [empleadoId]: 'arriba' | 'local' }
};

const esHoraHHMM = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);

const limpiarTurnos = (arr, porDefecto) => {
    const base = Array.isArray(arr) && arr.length ? arr : porDefecto;
    return base.map((t, i) => {
        const def = porDefecto[Math.min(i, porDefecto.length - 1)];
        return {
            entrada: esHoraHHMM(t && t.entrada) ? t.entrada : def.entrada,
            salida:  esHoraHHMM(t && t.salida)  ? t.salida  : def.salida
        };
    });
};

const limpiarHorarios = (d) => {
    const src = d && typeof d === 'object' ? d : {};
    const g = src.grupos && typeof src.grupos === 'object' ? src.grupos : {};
    const tol = Number(src.toleranciaMin);
    const asign = {};
    if (src.asignaciones && typeof src.asignaciones === 'object') {
        Object.keys(src.asignaciones).forEach(k => {
            const v = src.asignaciones[k];
            if (v === 'arriba' || v === 'local') asign[String(k)] = v;
        });
    }
    return {
        toleranciaMin: Number.isFinite(tol) && tol >= 0 ? Math.round(tol) : HORARIOS_PREDETERMINADOS.toleranciaMin,
        grupos: {
            arriba: { nombre: 'Arriba', turnos: limpiarTurnos(g.arriba && g.arriba.turnos, HORARIOS_PREDETERMINADOS.grupos.arriba.turnos) },
            local:  { nombre: 'Local',  turnos: limpiarTurnos(g.local  && g.local.turnos,  HORARIOS_PREDETERMINADOS.grupos.local.turnos) }
        },
        asignaciones: asign
    };
};

const escucharHorarios = (callback, onError) =>
    onSnapshot(doc(db, 'configuracion', 'horarios'), snap => {
        callback(limpiarHorarios(snap.exists() ? snap.data() : null));
    }, onError);

const guardarHorarios = (cfg) =>
    setDoc(doc(db, 'configuracion', 'horarios'), limpiarHorarios(cfg));

// ---------- Informe de dirección en Excel ----------
// La librería (SheetJS) se baja recién al pedir el informe y con versión fija, así una
// actualización del CDN no puede romper el tablero y la página no depende de ella al abrir.
let xlsxPromesa = null;
const cargarXLSX = () => {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxPromesa) return xlsxPromesa;
    xlsxPromesa = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.async = true;
        s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('No se pudo inicializar la librería de Excel.'));
        s.onerror = () => { xlsxPromesa = null; reject(new Error('No se pudo descargar la librería de Excel. Revisá la conexión e intentá de nuevo.')); };
        document.head.appendChild(s);
    });
    return xlsxPromesa;
};

// 'Agosto 2026' -> 'Julio 2026' (para el comparativo con el mes anterior)
const periodoAnterior = (periodo) => {
    const partes = (periodo || '').toLowerCase().trim().split(/\s+/);
    if (partes.length < 2) return null;
    let mes = MESES.indexOf(partes[0].replace('setiembre', 'septiembre'));
    let anio = parseInt(partes[1]);
    if (mes < 0 || !anio) return null;
    mes -= 1;
    if (mes < 0) { mes = 11; anio -= 1; }
    return `${MESES[mes].charAt(0).toUpperCase()}${MESES[mes].slice(1)} ${anio}`;
};

const mismoPeriodo = (a, b) => (a || '').toLowerCase().trim() === (b || '').toLowerCase().trim();

// Consolida las liquidaciones de un período por empleado (igual criterio que la tabla en pantalla)
const consolidarMes = (periodo, historial) => {
    const m = {};
    historial.filter(h => mismoPeriodo(h.periodo, periodo)).forEach(r => {
        if (!r.empleado) return;
        const id = r.empleado.id;
        const e = m[id] = m[id] || { id, nombre: r.empleado.nombre, q1: 0, q2: 0, mensual: 0, presentismo: 0, aguinaldo: 0, premios: 0, ctaCte: 0, otrosDesc: 0, total: 0, horasLiq: 0 };
        if (r.tipoLiquidacion === '1ra Quincena') e.q1 += Number(r.sueldoBase) || 0;
        else if (r.tipoLiquidacion === '2da Quincena') e.q2 += Number(r.sueldoBase) || 0;
        else e.mensual += Number(r.sueldoBase) || 0;
        e.presentismo += Number(r.presentismo) || 0;
        e.aguinaldo += Number(r.aguinaldo) || 0;
        e.premios += Number(r.premios) || 0;
        e.ctaCte += Number(r.descuentoCtaCte) || 0;
        e.otrosDesc += Number(r.otrosDescuentos) || 0;
        e.horasLiq += Number(r.totalHoras) || 0;
        e.total += Number(r.neto) || 0;
    });
    return m;
};

// Horas efectivamente trabajadas (de los fichajes) por empleado, en un conjunto de fichajes
const horasFichadasPorEmpleado = (fichajes) => {
    const m = {};
    calcularJornadas(fichajes).forEach(j => {
        if (j.completa) m[j.empleadoId] = (m[j.empleadoId] || 0) + j.horas;
    });
    return m;
};

const horaAMin = (hhmmss) => {
    const p = String(hhmmss || '').split(':');
    return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0);
};

// Primera entrada y última salida de cada empleado por día
const resumenDiario = (fichajes) => {
    const dias = {};
    fichajes.forEach(f => {
        const k = f.empleadoId + '|' + f.fecha;
        const r = dias[k] || (dias[k] = { empleadoId: f.empleadoId, nombre: f.empleadoNombre, fecha: f.fecha, entrada: null, salida: null });
        if (f.tipo === 'entrada') { if (!r.entrada || f.timestamp < r.entrada.timestamp) r.entrada = f; }
        else { if (!r.salida || f.timestamp > r.salida.timestamp) r.salida = f; }
    });
    return Object.values(dias).sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);
};

// Genera y descarga el informe de dirección (.xlsx) del período elegido.
const descargarExcelCEO = async ({ mes, empleados, historial, horarios }) => {
    const XLSX = await cargarXLSX();
    const cfg = limpiarHorarios(horarios);
    const rango = rangoDePeriodo(mes);
    if (!rango) throw new Error('Período inválido.');
    const mesAnt = periodoAnterior(mes);
    const rangoAnt = mesAnt ? rangoDePeriodo(mesAnt) : null;

    const [fichajesMes, fichajesAnt] = await Promise.all([
        obtenerFichajes(rangoEnMs(rango.desde, rango.hasta)),
        rangoAnt ? obtenerFichajes(rangoEnMs(rangoAnt.desde, rangoAnt.hasta)) : Promise.resolve([])
    ]);

    const infoEmp = {};
    empleados.forEach(e => { infoEmp[e.id] = { nombre: e.nombre, puesto: e.puesto || '', horasBase: e.horasBase || 190, grupo: cfg.asignaciones[String(e.id)] || '' }; });

    const consolidadoMes = consolidarMes(mes, historial);
    const consolidadoAnt = mesAnt ? consolidarMes(mesAnt, historial) : {};
    const horasFichMes = horasFichadasPorEmpleado(fichajesMes);
    const horasFichAnt = horasFichadasPorEmpleado(fichajesAnt);

    const nombreDe = (id, respaldo) => (infoEmp[id] && infoEmp[id].nombre) || respaldo || 'Empleado eliminado';
    const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

    const wb = XLSX.utils.book_new();

    // ----- Hoja 1: Sueldos y horas -----
    const h1 = [[`Informe de sueldos y horas — ${mes}`], [], [
        'Empleado', 'Puesto', '1ra Quincena', '2da Quincena', 'Total del mes',
        'Presentismo', 'Aguinaldo', 'Premios', 'Descuentos', 'Horas liquidadas', 'Horas fichadas', 'Horas base'
    ]];
    const idsMes = Object.keys(consolidadoMes).map(Number).filter(id => {
        const e = consolidadoMes[id];
        return e.total !== 0 || e.ctaCte !== 0 || e.otrosDesc !== 0;
    }).sort((a, b) => nombreDe(a).localeCompare(nombreDe(b)));

    const tot1 = { q1: 0, q2: 0, total: 0, presentismo: 0, aguinaldo: 0, premios: 0, desc: 0, horasLiq: 0, horasFich: 0 };
    idsMes.forEach(id => {
        const e = consolidadoMes[id];
        const desc = e.ctaCte + e.otrosDesc;
        const hFich = redondear(horasFichMes[id] || 0);
        h1.push([
            nombreDe(id, e.nombre), (infoEmp[id] && infoEmp[id].puesto) || '',
            redondear(e.q1), redondear(e.q2), redondear(e.total),
            redondear(e.presentismo), redondear(e.aguinaldo), redondear(e.premios),
            redondear(desc), redondear(e.horasLiq), hFich, (infoEmp[id] && infoEmp[id].horasBase) || 190
        ]);
        tot1.q1 += e.q1; tot1.q2 += e.q2; tot1.total += e.total; tot1.presentismo += e.presentismo;
        tot1.aguinaldo += e.aguinaldo; tot1.premios += e.premios; tot1.desc += desc;
        tot1.horasLiq += e.horasLiq; tot1.horasFich += (horasFichMes[id] || 0);
    });
    h1.push([
        'TOTALES', '', redondear(tot1.q1), redondear(tot1.q2), redondear(tot1.total),
        redondear(tot1.presentismo), redondear(tot1.aguinaldo), redondear(tot1.premios),
        redondear(tot1.desc), redondear(tot1.horasLiq), redondear(tot1.horasFich), ''
    ]);
    if (idsMes.length === 0) h1.push([], ['No hay liquidaciones cargadas para este período.']);
    const ws1 = XLSX.utils.aoa_to_sheet(h1);
    ws1['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 15 }, { wch: 13 }, { wch: 13 }, { wch: 12 }, { wch: 13 }, { wch: 15 }, { wch: 14 }, { wch: 11 }];
    aplicarFormatos(XLSX, ws1, 3, { 2: FMT_PESOS, 3: FMT_PESOS, 4: FMT_PESOS, 5: FMT_PESOS, 6: FMT_PESOS, 7: FMT_PESOS, 8: FMT_PESOS, 9: FMT_HORAS, 10: FMT_HORAS });
    XLSX.utils.book_append_sheet(wb, ws1, 'Sueldos y horas');

    // ----- Hoja 2: Comparativo con el mes anterior -----
    const h2 = [[`Comparativo ${mes} vs ${mesAnt || '—'}`], [], [
        'Empleado', 'Puesto', `Total ${mes}`, `Total ${mesAnt || 'ant.'}`, 'Diferencia $', 'Diferencia %',
        `Horas fich. ${mes}`, `Horas fich. ${mesAnt || 'ant.'}`, 'Dif. horas'
    ]];
    const idsComp = Array.from(new Set([...Object.keys(consolidadoMes), ...Object.keys(consolidadoAnt)].map(Number)))
        .filter(id => (consolidadoMes[id] && (consolidadoMes[id].total || consolidadoMes[id].ctaCte || consolidadoMes[id].otrosDesc)) ||
                      (consolidadoAnt[id] && (consolidadoAnt[id].total || consolidadoAnt[id].ctaCte || consolidadoAnt[id].otrosDesc)))
        .sort((a, b) => nombreDe(a).localeCompare(nombreDe(b)));
    const tot2 = { act: 0, ant: 0, hAct: 0, hAnt: 0 };
    idsComp.forEach(id => {
        const act = (consolidadoMes[id] && consolidadoMes[id].total) || 0;
        const ant = (consolidadoAnt[id] && consolidadoAnt[id].total) || 0;
        const hAct = horasFichMes[id] || 0;
        const hAnt = horasFichAnt[id] || 0;
        const dif = act - ant;
        const difPct = ant !== 0 ? redondear((dif / ant) * 100) : '';
        h2.push([
            nombreDe(id), (infoEmp[id] && infoEmp[id].puesto) || '',
            redondear(act), redondear(ant), redondear(dif), difPct,
            redondear(hAct), redondear(hAnt), redondear(hAct - hAnt)
        ]);
        tot2.act += act; tot2.ant += ant; tot2.hAct += hAct; tot2.hAnt += hAnt;
    });
    const difTot = tot2.act - tot2.ant;
    h2.push([
        'TOTALES', '', redondear(tot2.act), redondear(tot2.ant), redondear(difTot),
        tot2.ant !== 0 ? redondear((difTot / tot2.ant) * 100) : '',
        redondear(tot2.hAct), redondear(tot2.hAnt), redondear(tot2.hAct - tot2.hAnt)
    ]);
    const ws2 = XLSX.utils.aoa_to_sheet(h2);
    ws2['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 13 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
    aplicarFormatos(XLSX, ws2, 3, { 2: FMT_PESOS, 3: FMT_PESOS, 4: FMT_PESOS, 5: FMT_PCT, 6: FMT_HORAS, 7: FMT_HORAS, 8: FMT_HORAS });
    XLSX.utils.book_append_sheet(wb, ws2, 'Comparativo');

    // ----- Hoja 3: Puntualidad -----
    const etiquetaGrupo = (g) => g === 'arriba' ? 'Arriba' : g === 'local' ? 'Local' : '';
    const esperadoDe = (g) => {
        const turnos = cfg.grupos[g] ? cfg.grupos[g].turnos : [];
        if (!turnos.length) return null;
        return { entrada: turnos[0].entrada, salida: turnos[turnos.length - 1].salida };
    };
    const dias = resumenDiario(fichajesMes);
    const asignados = empleados.filter(e => infoEmp[e.id].grupo);
    const sinGrupoConFichajes = Array.from(new Set(fichajesMes.map(f => f.empleadoId)))
        .filter(id => !(infoEmp[id] && infoEmp[id].grupo))
        .map(id => nombreDe(id));

    const h3 = [[`Puntualidad — ${mes}`], [`Tolerancia: ${cfg.toleranciaMin} min · Arriba ${esperadoDe('arriba').entrada}–${esperadoDe('arriba').salida} · Local ${cfg.grupos.local.turnos.map(t => t.entrada + '–' + t.salida).join(' y ')}`]];
    if (sinGrupoConFichajes.length) h3.push([`Sin grupo asignado (no evaluados): ${sinGrupoConFichajes.join(', ')}`]);
    h3.push([]);

    // Resumen por empleado
    h3.push(['RESUMEN POR EMPLEADO']);
    h3.push(['Empleado', 'Grupo', 'Días trabajados', 'Días con tardanza', 'Días que salió antes']);
    const resumenEmp = {};
    const detalle = [];
    asignados.sort((a, b) => a.nombre.localeCompare(b.nombre)).forEach(emp => {
        const g = infoEmp[emp.id].grupo;
        const esp = esperadoDe(g);
        resumenEmp[emp.id] = { dias: 0, tarde: 0, antes: 0 };
        dias.filter(d => d.empleadoId === emp.id).forEach(d => {
            resumenEmp[emp.id].dias++;
            const entMin = d.entrada ? horaAMin(d.entrada.hora) : null;
            const salMin = d.salida ? horaAMin(d.salida.hora) : null;
            const minTarde = (entMin != null && esp) ? entMin - (horaAMin(esp.entrada) + cfg.toleranciaMin) : null;
            const minAntes = (salMin != null && esp) ? horaAMin(esp.salida) - salMin : null;
            const tarde = minTarde != null && minTarde > 0;
            const antes = minAntes != null && minAntes > 0;
            if (tarde) resumenEmp[emp.id].tarde++;
            if (antes) resumenEmp[emp.id].antes++;
            detalle.push([
                emp.nombre, etiquetaGrupo(g), fechaCorta(d.fecha),
                d.entrada ? d.entrada.hora.slice(0, 5) : '—',
                d.salida ? d.salida.hora.slice(0, 5) : '—',
                esp ? esp.entrada : '', esp ? esp.salida : '',
                tarde ? 'Sí' : 'No', tarde ? minTarde : '',
                antes ? 'Sí' : 'No', antes ? minAntes : ''
            ]);
        });
        const r = resumenEmp[emp.id];
        h3.push([emp.nombre, etiquetaGrupo(g), r.dias, r.tarde, r.antes]);
    });
    h3.push([]);
    h3.push(['DETALLE DIARIO']);
    h3.push(['Empleado', 'Grupo', 'Fecha', 'Entrada', 'Salida', 'Entrada esperada', 'Salida esperada', '¿Tarde?', 'Min. tarde', '¿Salió antes?', 'Min. antes']);
    if (asignados.length === 0) h3.push(['No hay empleados asignados a ningún grupo. Asignalos desde "Grupos y horarios".']);
    detalle.forEach(fila => h3.push(fila));
    const ws3 = XLSX.utils.aoa_to_sheet(h3);
    ws3['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 15 }, { wch: 15 }, { wch: 9 }, { wch: 10 }, { wch: 13 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Puntualidad');

    XLSX.writeFile(wb, `Informe_CEO_${String(mes).replace(/\s+/g, '_')}.xlsx`);
};

const FMT_PESOS = '"$ "#,##0.00';
const FMT_HORAS = '#,##0.00';
const FMT_PCT = '#,##0.0"%"';

// Aplica un formato de número a columnas (por índice) desde la fila `desde` hasta el final
const aplicarFormatos = (XLSX, ws, desde, formatos) => {
    if (!ws['!ref']) return;
    const rango = XLSX.utils.decode_range(ws['!ref']);
    for (let R = desde; R <= rango.e.r; R++) {
        Object.keys(formatos).forEach(c => {
            const ref = XLSX.utils.encode_cell({ r: R, c: Number(c) });
            const celda = ws[ref];
            if (celda && celda.t === 'n') celda.z = formatos[c];
        });
    }
};

window.Datos = {
    configurado,
    ZONA_AR,
    escucharSesion,
    iniciarSesion,
    cerrarSesion,
    cambiarPassword,
    enviarResetPassword,
    emailActual,
    esAdministrador,
    puedeUsarKiosco,
    errorAmigable,
    escucharEmpleados,
    escucharEmpleadosKiosco,
    guardarEmpleado,
    eliminarEmpleado,
    escucharHistorial,
    guardarLiquidacion,
    eliminarLiquidacion,
    actualizarNota,
    escucharFichajes,
    obtenerFichajes,
    registrarFichaje,
    registrarMarca,
    escucharPendientes,
    enviarPendientes,
    eliminarFichaje,
    guardarJornada,
    JORNADA_MAX_MS,
    ultimoFichaje,
    proximoTipo,
    estaPresente,
    calcularJornadas,
    rangoDePeriodo,
    rangoEnMs,
    FRASES_PREDETERMINADAS,
    escucharFrases,
    guardarFrases,
    restaurarFrases,
    HORARIOS_PREDETERMINADOS,
    escucharHorarios,
    guardarHorarios,
    descargarExcelCEO,
    periodoAnterior,
    importarRespaldo,
    esPinValido,
    hashPin,
    verificarPin,
    sincronizarHora,
    ahora,
    partesAR,
    timestampDesdeAR,
    fechaLarga,
    fechaCorta,
    formatearHoras
};
window.dispatchEvent(new Event('datos-listo'));
