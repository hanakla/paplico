import { coreDocsComponents } from "../_components/docsMdx";
import Introduction from "./_content/introduction.mdx";

export default function CoreDocsIndexPage() {
	return <Introduction components={coreDocsComponents} />;
}
