import chalk from 'chalk';

export function printHelp(): void {
  console.log(`
${chalk.bold('ai-image-labeling')} — AI-powered image classification and organization

${chalk.bold('USAGE')}
  ai-image-labeling [OPTIONS]
  ai-image-labeling diff <before> <after> [--output-format json]
  ai-image-labeling suggest-categories [OPTIONS]
  ai-image-labeling serve [OPTIONS]
  ai-image-labeling reorder
  ai-image-labeling single <number> <file>

${chalk.bold('OPTIONS')}
  --input, -i             <dir>     Directory with source images       (default: ./input)
  --output, -o            <dir>     Directory for processed files      (default: ./output)
  --provider              <name>    openai | anthropic | google | azure | ollama | bedrock | vertex  (default: openai)
  --api-key               <key>     OpenAI API key (overrides OPENAI_API_KEY)
  --anthropic-api-key     <key>     Anthropic API key (overrides ANTHROPIC_API_KEY)
  --google-api-key        <key>     Google AI API key (overrides GOOGLE_API_KEY)
  --azure-endpoint        <url>     Azure OpenAI endpoint (requires --provider azure)
  --azure-api-key         <key>     Azure OpenAI API key (overrides AZURE_OPENAI_API_KEY)
  --ollama-url            <url>     Ollama server URL    (requires --provider ollama)
  --bedrock-region        <region>  AWS region for Bedrock             (default: us-east-1)
  --bedrock-access-key-id <key>     AWS access key ID (overrides AWS_ACCESS_KEY_ID)
  --bedrock-secret-access-key <key> AWS secret access key (overrides AWS_SECRET_ACCESS_KEY)
  --vertex-project        <id>      Google Cloud project ID for Vertex AI (overrides GOOGLE_CLOUD_PROJECT)
  --vertex-location       <location> Google Cloud location for Vertex AI (default: us-central1)
  --model                 <model>   Model name  (defaults: gpt-4o / claude-opus-4-7 / gemini-2.0-flash / llava)
  --batch-size            <n>       Images per API call                (default: 20)
  --max-retries           <n>       Max retries on API errors          (default: 3)
  --concurrency           <n>       Concurrent API batch calls         (default: 3)
  --estimate                        Print cost estimate and exit (no API calls made)
  --temporal-window       <minutes> Temporal cluster window in minutes (default: 5)
  --consensus-threshold   <0-1>     Majority ratio for temporal override (default: 0.6)
  --dry-run                         Analyze without writing files
  --skip-analysis                   Use cached analysis_results.json
  --force-skip-analysis             Use cached results even if categories.json changed
  --categories            <file>    Path to custom categories.json
  --output-format         <fmt>     pretty | json | none               (default: pretty)
  --log-format            <fmt>     pretty | json                      (default: pretty)
  --timing                          Print per-step wall-time in run summary
  --filename-template     <pattern> Output filename template
                                    Default: "{n}. Photo of {category} dated {date}"
                                    Tokens:
                                      {n}              sequence number, zero-padded to 3 digits
                                      {n:4}            zero-padded to N digits  (e.g. 0001, 01)
                                      {category}       category slug
                                      {description}    LLM description as a URL-safe slug
                                      {date}           DD-MM-YYYY  (legacy shorthand)
                                      {date:FORMAT}    custom date — FORMAT uses:
                                                         YYYY  4-digit year    YY  2-digit year
                                                         MM    month (01-12)    M  month (1-12)
                                                         DD    day   (01-31)    D  day   (1-31)
                                      {datetime}       DD-MM-YYYY_HH-MM  (legacy shorthand)
                                      {datetime:FORMAT} custom datetime — FORMAT also accepts:
                                                         HH    hour  (00-23)    H  hour  (0-23)
                                                         mm    minute (00-59)   m  minute (0-59)
                                                         ss    second (00-59)   s  second (0-59)
                                    Template must include {n} or {n:N} to guarantee unique names.
  --watch                           Watch input directory for new images and process automatically
  --watch-poll                      Use polling for watch mode (required on NFS/SMB/Docker mounts)
  --interactive                     Review and override LLM classifications before processing (requires TTY)
  --active-learn                    Write active_learning_queue.json for images needing human review (confidence < 0.5 or unknown)
  --plugin <path>                   Load a lifecycle plugin .mjs file (repeatable, e.g. --plugin ./my-plugin.mjs)
  --webhook               <url>     POST results to this URL after each run completes
  --output-bucket         <uri>     Write outputs to cloud storage (s3://, gs://, azblob://)
  --embed                           Generate text embeddings after analysis (writes analysis_embeddings.index.json)
  --session-gap           <minutes> Split images into sessions at gaps larger than this many minutes
  --consensus-providers   <p1,p2>   Two comma-separated providers for multi-model consensus (e.g. "openai,anthropic")
                                    Images where providers disagree are flagged with lowConsensus: true
  --verbose, -v                     Show detailed debug logs
  --quiet, -q                       Suppress all non-error output
  --help, -h                        Show this help

${chalk.bold('DIFF SUBCOMMAND')}
  ai-image-labeling diff <before> <after> [OPTIONS]

  Compare two analysis_results.json files and show what changed between runs.
  Useful for auditing re-analysis after updating categories.json or model.

  --output-format <fmt>  pretty | json  (default: pretty)

  Examples:
    ${chalk.cyan('ai-image-labeling diff ./output/analysis_results.json ./output_v2/analysis_results.json')}
    ${chalk.cyan('ai-image-labeling diff before.json after.json --output-format json')}

${chalk.bold('SEARCH SUBCOMMAND')}
  ai-image-labeling search [OPTIONS]

  Search classified images by semantic query or keyword.
  Semantic search requires a prior run with --embed.

  --output, -o    <dir>    Output directory with analysis_results.json  (default: ./output)
  --query         <text>   Semantic search query (embeds query text, requires --embed index)
  --keyword       <text>   Keyword search over shortDescription, elements, extractedText
  --top           <n>      Maximum results to return                    (default: 10)
  --min-score     <n>      Minimum similarity score for semantic search (default: 0.4)
  --output-format <fmt>    pretty | json                                (default: pretty)

  Examples:
    ${chalk.cyan('ai-image-labeling search --query "kitchen with modern appliances" --top 10')}
    ${chalk.cyan('ai-image-labeling search --keyword "crack" --top 20')}

${chalk.bold('SUGGEST-CATEGORIES SUBCOMMAND')}
  ai-image-labeling suggest-categories [OPTIONS]

  Sample images from your input directory and ask the LLM to suggest a domain-appropriate
  category taxonomy. Writes a ready-to-use categories.json that you can edit and pass to
  --categories. Great for onboarding a new image domain without starting from scratch.

  --input, -i   <dir>   Input directory with source images   (default: ./input)
  --out         <file>  Output path for categories.json       (default: ./categories-suggested.json)
  --sample      <n>     Number of images to sample            (default: 20)
  --provider    <name>  LLM provider (same options as main command)
  --model       <name>  Model override

${chalk.bold('PROVIDERS')}
  openai     Uses GPT-4o by default. Set OPENAI_API_KEY or --api-key.
  anthropic  Uses claude-opus-4-7 by default. Set ANTHROPIC_API_KEY or --anthropic-api-key.
  google     Uses gemini-2.0-flash by default. Set GOOGLE_API_KEY or --google-api-key.
  azure      Uses deployment named by --model (default: gpt-4o). Requires --azure-endpoint and
             --azure-api-key (or AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY env vars).
  ollama     Uses local model named by --model (default: llava). Requires Ollama running locally.
             No API key needed. Set --ollama-url or OLLAMA_URL (default: http://localhost:11434).
  bedrock    Uses Claude on AWS Bedrock. No API key needed — authenticates via IAM (environment
             credentials, instance profile, or --bedrock-access-key-id/--bedrock-secret-access-key).
             Default model: anthropic.claude-opus-4-7-20250514-v1:0. Set --bedrock-region or
             AWS_REGION (default: us-east-1).
  vertex     Uses Gemini on Google Cloud Vertex AI. No API key needed — authenticates via
             Application Default Credentials (ADC) or a service account. Set --vertex-project or
             GOOGLE_CLOUD_PROJECT. Default model: gemini-2.0-flash. Set --vertex-location or use
             default us-central1.

${chalk.bold('EXAMPLES')}
  # Basic: analyze all images in ./input → ./output (OpenAI)
  ${chalk.cyan('ai-image-labeling')}

  # Use Anthropic Claude
  ${chalk.cyan('ai-image-labeling --provider anthropic --anthropic-api-key sk-ant-...')}

  # Use Google Gemini
  ${chalk.cyan('ai-image-labeling --provider google --google-api-key AIza...')}

  # Custom input/output with a specific model
  ${chalk.cyan('ai-image-labeling --input ~/photos --output ~/sorted --model gpt-4o-mini')}

  # Dry-run: classify without writing any files
  ${chalk.cyan('ai-image-labeling --dry-run')}

  # Preview cost across all providers before running
  ${chalk.cyan('ai-image-labeling --estimate')}

  # Run with higher concurrency (3 batches in-flight at once)
  ${chalk.cyan('ai-image-labeling --concurrency 5')}

  # Re-order after manually editing analysis_results.json
  ${chalk.cyan('ai-image-labeling reorder')}

  # Use a custom category taxonomy
  ${chalk.cyan('ai-image-labeling --categories ./my-categories.json')}

  # Use Azure OpenAI
  ${chalk.cyan('ai-image-labeling --provider azure --azure-endpoint https://my.openai.azure.com/ --azure-api-key <key>')}

  # Use Ollama (local, no API key needed)
  ${chalk.cyan('ai-image-labeling --provider ollama --model llava')}

  # Custom filename template — 4-digit number, ISO date, description slug
  ${chalk.cyan("ai-image-labeling --filename-template '{n:4}. {category} {date:YYYY-MM-DD} {description}'")}

  # Custom date format with slashes and time
  ${chalk.cyan("ai-image-labeling --filename-template '{n}_{datetime:YYYY-MM-DD_HH-mm}_{description}'")}

  # 2-digit sequence number, European date
  ${chalk.cyan("ai-image-labeling --filename-template '{n:2}. {category} {date:DD.MM.YYYY}'")}

  # Watch input directory and process new images as they arrive
  ${chalk.cyan('ai-image-labeling --watch')}

  # Watch with polling (required on NFS/SMB/Docker mounts)
  ${chalk.cyan('ai-image-labeling --watch --watch-poll')}
`);
}
