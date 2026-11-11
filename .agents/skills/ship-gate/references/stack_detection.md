# Stack Detection

Run these checks in order to identify the project stack:

```
Framework detection:
  package.json exists        -> Node.js project
    "next" in dependencies   -> Next.js
    "react" in dependencies  -> React (if not Next.js)
    "vue" in dependencies    -> Vue
    "svelte" in dependencies -> Svelte
    "astro" in dependencies  -> Astro
    "express" in dependencies -> Express
    "fastify" in dependencies -> Fastify
    "hono" in dependencies   -> Hono
  requirements.txt or pyproject.toml -> Python project
    "django" present         -> Django
    "flask" present          -> Flask
    "fastapi" present        -> FastAPI
  go.mod exists              -> Go project
  Cargo.toml exists          -> Rust project

Database detection:
  "@supabase/supabase-js" in package.json -> Supabase
  supabase/ directory exists              -> Supabase
  "prisma" in dependencies                -> Prisma (check schema for DB type)
  "mongoose" in dependencies              -> MongoDB
  "pg" or "postgres" in dependencies      -> PostgreSQL
  firebase.json or .firebaserc exists     -> Firebase

Deploy target detection:
  vercel.json or .vercel/ exists          -> Vercel
  netlify.toml exists                     -> Netlify
  Dockerfile exists                       -> Docker/VPS
  fly.toml exists                         -> Fly.io
  railway.json exists                     -> Railway
  .platform/applications.yaml            -> Platform.sh

Auth detection:
  "@clerk" in dependencies                -> Clerk
  "next-auth" in dependencies             -> NextAuth
  "@supabase/auth-helpers" in deps        -> Supabase Auth
  "firebase/auth" in imports              -> Firebase Auth

AI/LLM detection:
  "openai" in dependencies                -> OpenAI
  "@anthropic-ai/sdk" in dependencies     -> Claude API
  "@google/generative-ai" in deps         -> Gemini
```

Report detected stack before proceeding. This determines which checks
are relevant. Checks tagged with a specific stack in `checks.md`
are skipped if that stack is not detected.
