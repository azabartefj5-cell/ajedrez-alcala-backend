const admin = require('firebase-admin');

// 1. Cargar las credenciales de servicio
const serviceAccount = require('./firebase-adminsdk.json');

// 2. Inicializar la app de Firebase (Admin SDK)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// 3. Ruta de la colección a borrar
const COLLECTION_PATH = 'artifacts/ajedrez-alcala-app-v2/public/data/noticias';

async function deleteCollection(collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, resolveReject) => {
        deleteQueryBatch(db, query, resolve).catch(resolveReject);
    });
}

async function deleteQueryBatch(db, query, resolve) {
    const snapshot = await query.get();

    const batchSize = snapshot.docs.length;
    if (batchSize === 0) {
        resolve();
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

    process.nextTick(() => {
        deleteQueryBatch(db, query, resolve);
    });
}

async function main() {
    console.log(`Borrando todos los documentos en: ${COLLECTION_PATH}`);
    await deleteCollection(COLLECTION_PATH, 500);
    console.log(`Colección borrada exitosamente.`);
}

main().catch(console.error);
