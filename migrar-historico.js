const admin = require('firebase-admin');
const fs = require('fs');
const xml2js = require('xml2js');
const cheerio = require('cheerio'); // Librería para raspar y leer el HTML interno

// 1. Inicializar Firebase Admin (Credenciales de Dios)
const serviceAccount = require('./firebase-adminsdk.json'); // Archivo de claves privadas

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 2. Configuración de Rutas
const XML_FILE = 'Takeout/Blogger/Blogs/CLUB DE AJEDREZ ALCALÁ DE HENARES/feed.atom'; // El archivo exportado por Blogger
const COLLECTION_PATH = 'artifacts/ajedrez-alcala-app-v2/public/data/noticias';

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

// A) Generar el 'excerpt' (resumen) sin etiquetas HTML y máximo 250 palabras
function createExcerpt(htmlContent, wordLimit = 250) {
  if (!htmlContent) return '';
  const $ = cheerio.load(htmlContent);
  const text = $.text().trim().replace(/\s+/g, ' '); // Elimina todos los saltos de línea y el HTML oculto
  const words = text.split(' ');
  if (words.length <= wordLimit) return text;
  return words.slice(0, wordLimit).join(' ') + '...';
}

// B) Extraer la primera '<img src="...">' que encuentre en el texto para ser la Portada
function extractFirstImage(htmlContent) {
  if (!htmlContent) return null;
  const $ = cheerio.load(htmlContent);
  const imgUrl = $('img').first().attr('src');
  return imgUrl || null;
}

// ==========================================
// MOTOR DE MIGRACIÓN
// ==========================================
async function migrate() {
  console.log('Iniciando migración masiva desde Blogger...');

  try {
    // 1. Leer el archivo XML
    const xmlData = fs.readFileSync(XML_FILE, 'utf-8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);

    // 2. Blogger exporta un "feed". Las entradas están en 'feed.entry'
    const entries = result.feed.entry;

    if (!entries) {
      console.log('No se encontraron entradas válidas en el archivo XML.');
      return;
    }

    // 3. Filtrar para evitar páginas, plantillas o borradores (Blogger guarda TODO aquí)
    const posts = entries.filter(entry => {
      let isPost = false;
      let isLive = false;

      if (entry['blogger:type'] && entry['blogger:type'][0] === 'POST') {
        isPost = true;
      }

      if (entry['blogger:status'] && entry['blogger:status'][0] === 'LIVE') {
        isLive = true;
      }

      return isPost && isLive;
    });

    console.log(`Analizadas etiquetas del XML. Detectados ${posts.length} artículos a migrar.`);

    let count = 0;

    // 4. Bucle que inyectará uno por uno a Firestore
    for (const post of posts) {

      // -- TÍTULO -- 
      // Xml2js mete los textos en arrays o propiedades raras ('_'). Intentamos normalizarlo.
      const title = post.title && post.title[0] && post.title[0]._ ? post.title[0]._ : (post.title ? post.title[0] : 'Artículo sin título');

      // -- CONTENIDO HTML --
      const contentHtml = post.content && post.content[0] && post.content[0]._ ? post.content[0]._ : '';

      // -- FECHA (TIMESTAMP FIRESTORE) --
      const published = post.published ? post.published[0] : new Date().toISOString();
      const createdAt = admin.firestore.Timestamp.fromDate(new Date(published));

      // -- CATEGORÍA --
      // Por defecto ponemos 'Archivo', pero si Blogger tenía etiquetas (tags), agarramos la primera.
      let category = "Archivo Histórico";
      if (post.category) {
        // Agarramos las etiquetas que no sean marcadores internos de arquitectura
        const tags = post.category
          .filter(cat => cat.$ && cat.$.scheme === "http://www.blogger.com/atom/ns#")
          .map(cat => cat.$.term);

        if (tags.length > 0) {
          category = tags[0];
        }
      }

      // -- PORTADA Y RESUMEN (Procesados desde el HTML) --
      const excerpt = createExcerpt(contentHtml, 150);
      const imageUrl = extractFirstImage(contentHtml);

      // -- EXTRAER ID ÚNICO DEL ARTÍCULO --
      // El feed de Blogger suele traer un ID como "tag:blogger.com,1999:blog-1234.post-5678"
      // Lo limpiamos para que sea una cadena alfanumérica segura para Firestore
      let docId = '';
      if (post.id && post.id[0]) {
        docId = post.id[0].replace(/[^a-zA-Z0-9]/g, '-');
      } else {
        // Fallback seguro si no hay ID
        docId = `post-${new Date(createdAt.toDate()).getTime()}-${Math.floor(Math.random() * 1000)}`;
      }

      // 5. Montar "el esquema" que me pediste originalmente
      const documentData = {
        title: title,
        category: category,
        excerpt: excerpt,
        contentHtml: contentHtml,
        imageUrl: imageUrl,
        createdAt: createdAt
      };

      // 6. Impactar en base de datos Firestore (usamos set con el ID del post para evitar duplicados si se ejecuta más veces)
      await db.collection(COLLECTION_PATH).doc(docId).set(documentData);

      count++;
      console.log(`[${count}/${posts.length}] Inyectando: ${title}`);
    }

    console.log(`\n========================================`);
    console.log(`✅ ¡MIGRACIÓN COMPLETADA! Se subieron ${count} artículos al club.`);
    console.log(`========================================\n`);

  } catch (error) {
    console.error('Ocurrió un error leyendo o subiendo los datos:', error);
  }
}

// Inicializar el script
migrate();
