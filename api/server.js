// ============================================
// 🏆 Panel de Noticias con IA — Servidor Backend
// Club Municipal de Ajedrez de Alcalá de Henares
// ============================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');

// ============================================
// 1. CONFIGURACIÓN DE SERVICIOS
// ============================================

// Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Firebase Admin (soporta archivo local o variable de entorno para Vercel)
let db;
if (!admin.apps.length) {
    try {
        let serviceAccount;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            console.log('📡 Intentando inicializar Firebase desde variable de entorno...');
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            } catch (jsonErr) {
                console.error('❌ Error parsing FIREBASE_SERVICE_ACCOUNT JSON:', jsonErr.message);
                // Si falla el parseo, intentamos cargarlo de nuevo pero limpiando posibles escapes mal hechos
                try {
                    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n'));
                } catch (e2) {
                    throw new Error('Formato JSON de FIREBASE_SERVICE_ACCOUNT inválido');
                }
            }
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            console.log('✅ Firebase inicializado correctamente (Vercel)');
        } else {
            console.log('🏠 Buscando archivo local firebase-adminsdk.json...');
            serviceAccount = require(path.join(__dirname, '..', 'firebase-adminsdk.json'));
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            console.log('✅ Firebase inicializado correctamente (Local)');
        }
        db = admin.firestore();
    } catch (e) {
        console.error('❌ Error crítico inicializando Firebase:', e.message);
        // No lanzamos error para que el servidor no pete, pero db será undefined
    }
} else {
    db = admin.firestore();
}

// Ruta de la colección de noticias (misma que usa la web pública)
const NOTICIAS_COLLECTION = 'artifacts/ajedrez-alcala-app-v2/public/data/noticias';

// ============================================
// 2. CONFIGURACIÓN DE EXPRESS
// ============================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer: almacena las fotos en memoria (buffer) para subirlas directamente a Cloudinary
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB por imagen
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se permiten imágenes (JPG, PNG, WEBP, AVIF)'));
    },
});

// ============================================
// 3. RUTAS
// ============================================

// --- Diagnóstico de salud ---
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        firebaseInit: !!db,
        env: {
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
            hasFirebaseKey: !!process.env.FIREBASE_SERVICE_ACCOUNT,
            hasCloudinaryKey: !!process.env.CLOUDINARY_CLOUD_NAME,
            hasAdminPassword: !!process.env.ADMIN_PASSWORD,
            nodeEnv: process.env.NODE_ENV || 'development'
        }
    });
});

// --- Servir admin.html solo en desarrollo local ---
if (process.env.NODE_ENV !== 'production') {
    app.get('/', (req, res) => {
        res.redirect('/admin');
    });
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'admin.html'));
    });
}

// --- Verificar contraseña ---
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
});

// --- Pipeline principal: Generar + Publicar noticia ---
app.post('/api/generar-noticia', upload.array('fotos', 20), async (req, res) => {
    try {
        const { textoEnBruto, categoria, password } = req.body;

        // Verificar contraseña
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'No autorizado' });
        }

        if (!textoEnBruto || textoEnBruto.trim().length < 10) {
            return res.status(400).json({ error: 'El texto es demasiado corto. Escribe al menos unas líneas sobre el evento.' });
        }

        console.log(`\n📝 Nueva noticia recibida. Categoría: ${categoria}`);
        console.log(`📷 Fotos adjuntas: ${req.files ? req.files.length : 0}`);

        // ----- PASO 1: Subir fotos a Cloudinary -----
        let imagenesCloudinary = [];

        if (req.files && req.files.length > 0) {
            console.log('☁️  Subiendo fotos a Cloudinary...');

            const uploadPromises = req.files.map((file, index) => {
                return new Promise((resolve, reject) => {
                    const timestamp = Date.now();
                    const uploadStream = cloudinary.uploader.upload_stream(
                        {
                            folder: 'ajedrez-alcala/noticias',
                            public_id: `noticia_${timestamp}_${index}`,
                            transformation: [
                                { width: 1200, height: 800, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' },
                            ],
                        },
                        (error, result) => {
                            if (error) reject(error);
                            else resolve({
                                url: result.secure_url,
                                width: result.width,
                                height: result.height,
                                alt: `Imagen ${index + 1} del evento`,
                            });
                        }
                    );
                    uploadStream.end(file.buffer);
                });
            });

            imagenesCloudinary = await Promise.all(uploadPromises);
            console.log(`✅ ${imagenesCloudinary.length} fotos subidas correctamente.`);
        }

        // ----- PASO 2: Generar artículo con Gemini -----
        console.log('🤖 Generando artículo con Gemini...');

        const listaImagenes = imagenesCloudinary
            .map((img, i) => `  - Imagen ${i + 1}: ${img.url}`)
            .join('\n');

        const prompt = `Eres un periodista deportivo especializado en ajedrez que escribe crónicas y noticias para el Club Municipal de Ajedrez de Alcalá de Henares. Tu estilo es profesional pero cercano, natural y ameno. Nunca suenas robótico ni genérico.

TEXTO EN BRUTO DEL EVENTO (datos que te proporciona el organizador):
---
${textoEnBruto}
---

CATEGORÍA DEL ARTÍCULO: ${categoria || 'Noticia'}

${imagenesCloudinary.length > 0 ? `IMÁGENES DISPONIBLES (URLs de Cloudinary ya subidas):
${listaImagenes}` : 'No se han proporcionado imágenes para este artículo.'}

INSTRUCCIONES DE REDACCIÓN:
1. Redacta una noticia/crónica completa y atractiva a partir de los datos proporcionados.
2. El título debe ser llamativo y descriptivo (NO genérico).
3. El excerpt (resumen) debe tener entre 1 y 3 frases que enganchen al lector.
4. El contenido HTML debe ser rico y bien estructurado:
   - Usa párrafos <p> para el texto narrativo.
   - Usa <h3> para los subtítulos dentro del artículo.
   - Usa <strong> para destacar nombres de jugadores, resultados o datos importantes.
   - Si hay clasificaciones o resultados, preséntalos en una tabla HTML con clases para estilizado:
     <table class="results-table"><thead><tr><th>Pos.</th><th>Jugador</th><th>Puntos</th></tr></thead><tbody>...</tbody></table>
   - Si hay premios, destácalos en un bloque especial:
     <div class="prizes-block"><h3>🏆 Premios</h3><ul>...</ul></div>
${imagenesCloudinary.length > 0 ? `5. IMPORTANTE - Integra las imágenes en el cuerpo del artículo de forma natural y atractiva:
   - Distribuye las imágenes a lo largo del texto, NO las pongas todas juntas.
   - Usa este formato para CADA imagen:
     <figure class="article-image">
       <img src="URL_DE_LA_IMAGEN" alt="Descripción relevante de la imagen" loading="lazy">
       <figcaption>Pie de foto descriptivo y contextual</figcaption>
     </figure>
   - Si hay 2+ imágenes consecutivas que quieras mostrar juntas, usa una galería:
     <div class="image-gallery">
       <figure class="article-image">...</figure>
       <figure class="article-image">...</figure>
     </div>
   - Escribe pies de foto (figcaption) creativos y descriptivos que aporten contexto.
   - La primera imagen del artículo será usada como portada.` : '5. No hay imágenes disponibles, centra el artículo en el texto.'}
6. Escribe en español de España.
7. NO inventes datos, clasificaciones ni nombres que no aparezcan en el texto original.
8. Sé creativo con la narrativa pero fiel a los hechos.

FORMATO DE RESPUESTA (devuelve SOLO este JSON, sin markdown, sin backticks):
{
  "title": "Título atractivo del artículo",
  "excerpt": "Resumen enganchador de 1-3 frases",
  "contentHtml": "<p>HTML completo del artículo con imágenes integradas...</p>",
  "category": "${categoria || 'Noticia'}"
}`;

        // Llamar a xAI (Grok) vía API compatible con OpenAI
        async function callXAI(promptText) {
            const xaiKey = process.env.XAI_API_KEY;
            if (!xaiKey) throw new Error('XAI_API_KEY no configurada');

            console.log('🔄 Intentando con xAI (Grok)...');
            const response = await fetch('https://api.x.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${xaiKey}`,
                },
                body: JSON.stringify({
                    model: 'grok-3-mini-fast',
                    messages: [{ role: 'user', content: promptText }],
                    temperature: 0.7,
                }),
            });

            if (!response.ok) {
                const errBody = await response.text();
                throw new Error(`xAI error ${response.status}: ${errBody}`);
            }

            const data = await response.json();
            return data.choices[0].message.content;
        }

        // Llamar a IA con fallback entre proveedores
        async function callAIWithFallback(promptText) {
            // Intento 1: xAI (Grok) — prioridad porque Gemini tiene cuota limitada
            try {
                const xaiResult = await callXAI(promptText);
                console.log('✅ Respuesta recibida de xAI (Grok)');
                return xaiResult;
            } catch (xaiErr) {
                console.log('⚠️ xAI falló:', xaiErr.message);
            }

            // Intento 2: Gemini 2.0 Flash
            try {
                console.log('📡 Intentando con Gemini (gemini-2.0-flash)...');
                const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
                const result = await model.generateContent(promptText);
                console.log('✅ Respuesta recibida de Gemini');
                return result.response.text();
            } catch (geminiErr) {
                console.log('⚠️ Gemini 2.0 falló:', geminiErr.message);
            }

            // Intento 3: Gemini 2.5 Flash
            try {
                console.log('📡 Último intento con Gemini (gemini-2.5-flash)...');
                const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
                const result = await model.generateContent(promptText);
                console.log('✅ Respuesta recibida de Gemini 2.5');
                return result.response.text();
            } catch (lastErr) {
                throw new Error(`Todos los proveedores de IA fallaron. Último error: ${lastErr.message}`);
            }
        }

        const responseText = await callAIWithFallback(prompt);
        console.log('📥 Respuesta recibida de Gemini. Longitud:', responseText.length);
        console.log('📥 Primeros 300 chars:', responseText.substring(0, 300));

        // ====== PARSEO ROBUSTO DEL JSON DE GEMINI ======
        let articulo = null;

        // Estrategia 1: Limpiar markdown y parsear directamente
        try {
            let cleanJson = responseText
                .replace(/^\uFEFF/, '')                // BOM
                .replace(/```json\s*/gi, '')            // Bloque json
                .replace(/```\s*/gi, '')                // Cierre de bloque
                .trim();
            articulo = JSON.parse(cleanJson);
            console.log('✅ JSON parseado (estrategia 1: limpieza directa)');
        } catch (e1) {
            console.log('⚠️ Estrategia 1 falló:', e1.message);
        }

        // Estrategia 2: Buscar el JSON con regex (primer { ... último })
        if (!articulo) {
            try {
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    articulo = JSON.parse(jsonMatch[0]);
                    console.log('✅ JSON parseado (estrategia 2: regex extracción)');
                }
            } catch (e2) {
                console.log('⚠️ Estrategia 2 falló:', e2.message);
            }
        }

        // Estrategia 3: Extraer campos individualmente con regex
        if (!articulo) {
            try {
                const titleMatch = responseText.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                const excerptMatch = responseText.match(/"excerpt"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                const categoryMatch = responseText.match(/"category"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                // contentHtml puede contener comillas escapadas, lo extraemos entre "contentHtml": " y la siguiente clave o final
                const contentMatch = responseText.match(/"contentHtml"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"(?:category|title|excerpt)"|\"\s*\})/);

                if (titleMatch) {
                    articulo = {
                        title: titleMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
                        excerpt: excerptMatch ? excerptMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : '',
                        contentHtml: contentMatch ? contentMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t') : '<p>Contenido no disponible</p>',
                        category: categoryMatch ? categoryMatch[1] : categoria,
                    };
                    console.log('✅ JSON parseado (estrategia 3: extracción campo a campo)');
                }
            } catch (e3) {
                console.log('⚠️ Estrategia 3 falló:', e3.message);
            }
        }

        if (!articulo || !articulo.title) {
            console.error('❌ No se pudo parsear la respuesta de Gemini.');
            console.log('Respuesta completa:', responseText);
            return res.status(500).json({
                error: 'La IA generó una respuesta con formato incorrecto. Intenta de nuevo.',
                raw: responseText.substring(0, 2000),
            });
        }

        console.log(`✅ Artículo generado: "${articulo.title}"`);

        // ----- PASO 3: Devolver el artículo al frontend para vista previa -----
        const articuloCompleto = {
            title: articulo.title,
            excerpt: articulo.excerpt,
            contentHtml: articulo.contentHtml,
            category: articulo.category || categoria || 'Noticia',
            imageUrl: imagenesCloudinary.length > 0 ? imagenesCloudinary[0].url : null,
            imagenes: imagenesCloudinary,
        };

        console.log('📤 Enviando artículo al frontend...');
        res.json({ success: true, articulo: articuloCompleto });

    } catch (error) {
        console.error('❌ Error en el pipeline:', error);
        res.status(500).json({ error: `Error del servidor: ${error.message}` });
    }
});

// --- Publicar artículo en Firebase ---
app.post('/api/publicar', async (req, res) => {
    try {
        const { articulo, password } = req.body;

        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'No autorizado' });
        }

        if (!articulo || !articulo.title) {
            return res.status(400).json({ error: 'No hay artículo para publicar.' });
        }

        console.log(`📤 Publicando en Firebase: "${articulo.title}"`);

        const docData = {
            title: articulo.title,
            excerpt: articulo.excerpt,
            contentHtml: articulo.contentHtml,
            category: articulo.category,
            imageUrl: articulo.imageUrl || null,
            createdAt: admin.firestore.Timestamp.now(),
        };

        const docRef = await db.collection(NOTICIAS_COLLECTION).add(docData);

        console.log(`✅ Publicado con ID: ${docRef.id}`);
        res.json({ success: true, id: docRef.id });

    } catch (error) {
        console.error('❌ Error publicando:', error);
        res.status(500).json({ error: `Error publicando: ${error.message}` });
    }
});

// --- Listar artículos publicados ---
app.get('/api/articulos', async (req, res) => {
    try {
        const password = req.headers['x-admin-password'];
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'No autorizado' });
        }

        const snapshot = await db.collection(NOTICIAS_COLLECTION)
            .orderBy('createdAt', 'desc')
            .get();

        const articulos = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            articulos.push({
                id: doc.id,
                title: data.title,
                excerpt: data.excerpt,
                contentHtml: data.contentHtml,
                category: data.category,
                imageUrl: data.imageUrl,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
            });
        });

        console.log(`📋 Listando ${articulos.length} artículos`);
        res.json({ articulos });
    } catch (error) {
        console.error('❌ Error listando artículos:', error);
        res.status(500).json({ error: `Error: ${error.message}` });
    }
});

// --- Actualizar artículo ---
app.put('/api/articulos/:id', async (req, res) => {
    try {
        const { password, articulo } = req.body;
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'No autorizado' });
        }

        const docId = req.params.id;
        const updateData = {};
        if (articulo.title) updateData.title = articulo.title;
        if (articulo.excerpt) updateData.excerpt = articulo.excerpt;
        if (articulo.contentHtml) updateData.contentHtml = articulo.contentHtml;
        if (articulo.category) updateData.category = articulo.category;

        await db.collection(NOTICIAS_COLLECTION).doc(docId).update(updateData);

        console.log(`✏️ Artículo actualizado: ${docId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error actualizando:', error);
        res.status(500).json({ error: `Error: ${error.message}` });
    }
});

// --- Eliminar artículo ---
app.delete('/api/articulos/:id', async (req, res) => {
    try {
        const password = req.headers['x-admin-password'];
        if (password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'No autorizado' });
        }

        const docId = req.params.id;
        await db.collection(NOTICIAS_COLLECTION).doc(docId).delete();

        console.log(`🗑️ Artículo eliminado: ${docId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error eliminando:', error);
        res.status(500).json({ error: `Error: ${error.message}` });
    }
});

// ============================================
// 4. ARRANCAR SERVIDOR / EXPORTAR APP
// ============================================

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('');
        console.log('=========================================');
        console.log('  🏆 Panel de Noticias con IA — Activo');
        console.log('=========================================');
        console.log(`  📍 Panel Admin:  http://localhost:${PORT}/admin`);
        console.log(`  🔑 Contraseña:   ${process.env.ADMIN_PASSWORD}`);
        console.log('=========================================');
        console.log('');
    });
}

// Exportar la aplicación para Vercel Serverless
module.exports = app;
