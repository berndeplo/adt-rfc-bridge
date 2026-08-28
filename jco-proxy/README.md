# jco-proxy

A small Java sidecar (`com.sap.mcp.proxy.RfcProxyServer`) that adt-rfc-bridge
spawns. It accepts `ProxyRequest` JSON envelopes over HTTP and invokes SAP's
`SADT_REST_RFC_ENDPOINT` function module over JCo/RFC, returning a
`ProxyResponse`.

This is original MIT-licensed code (see the repo `LICENSE`). The SAP JCo
dependency is scoped `provided`, so the built fat-jar contains **no** SAP JCo
bytes — JCo is supplied at runtime from the libraries `npm run setup` copies
into `../jco-libs/`.

## Rebuilding `jco-proxy.jar`

Requires JDK 21+ and Maven. SAP JCo (`sapjco3`) must be resolvable to the Maven
compiler. If it is not already in your local Maven repo, install it from the
JCo jar in your Eclipse ADT install (one-time):

    mvn install:install-file -DgroupId=com.sap.conn.jco -DartifactId=sapjco3 \
      -Dversion=3.1.12 -Dpackaging=jar \
      -Dfile=/path/to/Eclipse/plugins/com.sap.conn.jco_3.1.12.jar

Then build and refresh the committed jar:

    mvn -f pom.xml clean package
    cp target/jco-proxy-1.0.0.jar ../jco-proxy.jar
