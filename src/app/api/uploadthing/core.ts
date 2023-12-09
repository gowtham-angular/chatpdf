import { createUploadthing, type FileRouter } from "uploadthing/next";
import { getKindeServerSession } from '@kinde-oss/kinde-auth-nextjs/server';
import { db } from "@/db";

const f = createUploadthing();

import { PDFLoader } from "langchain/document_loaders/fs/pdf";

import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { PineconeStore } from "langchain/vectorstores/pinecone";


import { Pinecone } from '@pinecone-database/pinecone';

const pinecone = new Pinecone({ 
  apiKey: process.env.PINECONE_API_KEY!,
  environment: 'gcp-starter',
})
export const ourFileRouter = {
    pdfUploader: f({ pdf: { maxFileSize: "4MB" } })
        .middleware(async ({ req }) => {
            const { getUser } = getKindeServerSession()
            const user = await getUser();

            if (!user || !user.id) throw new Error("Unauthorized");

            return { userId: user.id };
        })
        .onUploadComplete(async ({ metadata, file }) => {
            const createdFile = await db.file.create({
                data: {
                    key: file.key,
                    name: file.name,
                    userId: metadata.userId,
                    url: `https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`,
                    uploadStatus: 'PROCESSING',
                }
            })

            try {
                const response = await fetch(`https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`)
                const blob = await response.blob()

                const loader = new PDFLoader(blob);
                const pageLevelDocs = await loader.load()

                const pagesAmt = pageLevelDocs.length
                // vectorize and index entire document
                await pinecone.createIndex({
                    name: "chatpdf",
                    dimension: 1536,
                    metric: "cosine",
                });
                await pinecone.describeIndex("chatpdf");
                const pineconeIndex = pinecone.Index('chatpdf')
                const embeddings = new OpenAIEmbeddings({
                    openAIApiKey: process.env.OPENAI_API_KEY
                })
                await PineconeStore.fromDocuments(pageLevelDocs, embeddings,
                    {
                        pineconeIndex,
                        namespace: createdFile.id
                    })
                await db.file.update({
                    data: {
                        uploadStatus: 'SUCCESS',
                    },
                    where: {
                        id: createdFile.id
                    }
                })

            } catch (error) {
                console.log("error", error)
                await db.file.update({
                    data: {
                        uploadStatus: 'FAILED',
                    },
                    where: {
                        id: createdFile.id
                    }
                })
            }

            return {};
        }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;